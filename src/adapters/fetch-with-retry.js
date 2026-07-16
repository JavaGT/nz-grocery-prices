export class TimeoutError extends Error {
  get name() { return 'TimeoutError' }
}

function isRetryableStatus(status) {
  return status === 429 || status === 502 || status === 503 || status === 504;
}

function isRetryableNetworkError(error) {
  if (error.name === 'TimeoutError') return true;
  if (error.cause?.code === 'ECONNRESET') return true;
  if (error.cause?.code === 'ETIMEDOUT') return true;
  if (error.cause?.code === 'ECONNREFUSED') return true;
  if (error.cause?.code === 'ENOTFOUND') return true;
  if (error.cause?.code === 'EAI_AGAIN') return true;
  return false;
}

function parseRetryAfterSeconds(response, clock, maxDelay) {
  const header = response.headers?.get('retry-after');
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isInteger(seconds) && seconds >= 0) {
    return Math.min(seconds * 1000, maxDelay);
  }
  const parsed = Date.parse(header);
  if (!Number.isNaN(parsed)) {
    return Math.min(Math.max(0, parsed - clock()), maxDelay);
  }
  return null;
}

function computeBackoffDelay(attempt, { baseDelay = 1000, maxDelay = 30000 }, random) {
  const exponential = Math.min(baseDelay * (2 ** attempt), maxDelay);
  const jitter = Math.round(exponential * 0.2 * random());
  return Math.min(exponential + jitter, maxDelay);
}

async function attemptFetch(url, { attempt, fetchOptions, fetch, method, timeout, callerSignal, clock }) {
  if (callerSignal?.aborted) throw callerSignal.reason;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(new TimeoutError('Request timed out')), timeout);

  let abortHandler;
  if (callerSignal) {
    abortHandler = () => {
      clearTimeout(timeoutId);
      controller.abort(callerSignal.reason);
    };
    callerSignal.addEventListener('abort', abortHandler, { once: true });
  }

  try {
    const response = await fetch(url, { ...fetchOptions, method, signal: controller.signal });
    return response;
  } finally {
    clearTimeout(timeoutId);
    if (callerSignal && abortHandler) {
      callerSignal.removeEventListener('abort', abortHandler);
    }
  }
}

export async function fetchWithRetry(url, options = {}) {
  const {
    fetch = globalThis.fetch,
    sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms)),
    random = Math.random,
    clock = Date.now,
    retry: retryConfig,
    signal: callerSignal,
    timeout = 15000,
    method = 'GET',
    ...fetchOptions
  } = options;

  const canRetry = method === 'GET' && retryConfig !== false;

  if (!canRetry) {
    const response = await attemptFetch(url, {
      attempt: 0,
      fetchOptions, fetch, method, timeout, callerSignal, clock,
    });
    return response;
  }

  const { attempts = 3, baseDelay = 1000, maxDelay = 30000 } = retryConfig ?? {};
  let lastError;

  for (let attempt = 0; attempt <= attempts; attempt++) {
    let response;
    try {
      response = await attemptFetch(url, {
        attempt,
        fetchOptions, fetch, method, timeout, callerSignal, clock,
      });
    } catch (error) {
      if (callerSignal?.aborted) throw error;
      if (!isRetryableNetworkError(error) || attempt >= attempts) throw error;
      lastError = error;
      const delay = computeBackoffDelay(attempt, { baseDelay, maxDelay }, random);
      await sleep(delay);
      continue;
    }

    if (isRetryableStatus(response.status) && attempt < attempts) {
      try { await response.body?.cancel(); } catch { /* ignore */ }
      const delay = parseRetryAfterSeconds(response, clock, maxDelay)
        ?? computeBackoffDelay(attempt, { baseDelay, maxDelay }, random);
      await sleep(delay);
      continue;
    }

    return response;
  }

  throw lastError ?? new Error('fetchWithRetry: maximum retries exceeded');
}
