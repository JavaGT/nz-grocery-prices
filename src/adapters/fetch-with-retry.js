export class TimeoutError extends Error {
  get name() { return 'TimeoutError' }
}

/**
 * Hard cap on buffered response bodies (matches the curl adapters'
 * maxBuffer). A retailer (or anything in between) serving an unbounded
 * body must not balloon collector memory.
 */
const MAX_BODY_BYTES = 20 * 1024 * 1024;

async function readStreamCapped(body, maxBytes, label) {
  const reader = body.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value?.byteLength ?? value?.length ?? 0;
      if (total > maxBytes) {
        throw new Error(`${label}: streamed past the ${maxBytes} byte cap mid-read`);
      }
      chunks.push(value);
    }
  } catch (error) {
    try { await body.cancel(); } catch { /* teardown is best-effort */ }
    throw error;
  } finally {
    try { reader.releaseLock(); } catch { /* already released */ }
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)))
    .toString('utf8');
}

/**
 * Read a response body to a string, refusing to buffer more than maxBytes.
 * A declared Content-Length over the cap is refused before any read;
 * streamed bodies are capped chunk-wise; non-stream bodies (test doubles)
 * fall back to .text().
 */
export async function readBodyText(response, { maxBytes = MAX_BODY_BYTES, label = 'response body' } = {}) {
  const declared = Number.parseInt(response?.headers?.get?.('content-length') ?? '', 10);
  if (Number.isFinite(declared) && declared > maxBytes) {
    try { await response.body?.cancel?.(); } catch { /* teardown is best-effort */ }
    throw new Error(`${label}: declared Content-Length ${declared} exceeds the ${maxBytes} byte cap`);
  }
  if (response?.body && typeof response.body.getReader === 'function') {
    return readStreamCapped(response.body, maxBytes, label);
  }
  if (typeof response?.text === 'function') return response.text();
  throw new Error(`${label}: response exposes neither a stream nor text() to read`);
}

function jsonContextError(response, operation, text, cause) {
  const prefix = text ? String(text).slice(0, 120).replace(/\s+/g, ' ').trim() : '';
  const contentType = response?.headers?.get?.('content-type') ?? 'unknown content-type';
  return new Error(
    `${operation}: expected JSON but got ${response?.status ?? '?'} ${response?.statusText ?? ''} ` +
    `(${contentType}) — ${cause.message}` + (prefix ? `; body starts: ${prefix}` : ''),
  );
}

/**
 * Read a JSON response hardened against the failure modes that cost
 * diagnosis time: a WAF challenge served with status 200 must produce an
 * error naming the operation, status, content-type, and a body prefix —
 * not a bare "Unexpected token". Bodies go through readBodyText so they
 * are size-capped. Response doubles that expose only .json() (no stream,
 * no text) still work.
 */
export async function parseJsonResponse(response, operation, { maxBytes = MAX_BODY_BYTES } = {}) {
  if (!response?.body && typeof response?.json === 'function') {
    try {
      return await response.json();
    } catch (error) {
      throw jsonContextError(response, operation, undefined, error);
    }
  }
  const text = await readBodyText(response, { maxBytes, label: `${operation} response` });
  try {
    return JSON.parse(text);
  } catch (error) {
    throw jsonContextError(response, operation, text, error);
  }
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
