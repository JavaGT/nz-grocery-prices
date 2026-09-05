/**
 * Shared HTTP plumbing for the retailers/ campaign adapters.
 *
 * Reuses the hardened fetchWithRetry/parseJsonResponse seams from
 * src/adapters (timeouts, retry with backoff, WAF-context errors, body cap)
 * so every campaign client inherits the same failure semantics.
 */

import { fetchWithRetry, parseJsonResponse, readBodyText } from "../../src/adapters/fetch-with-retry.js";

export const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36";

export function assertOk(response, operation) {
  if (response.ok) return response;
  throw new Error(`${operation} failed: ${response.status} ${response.statusText}`);
}

/**
 * GET a URL and parse the body as JSON, with retries and hard errors that
 * name the operation. `options`: { fetch, headers, timeout, retry, signal }.
 */
export async function getJson(url, options = {}) {
  const { fetch, headers, timeout, retry, signal } = options;
  const response = await fetchWithRetry(url, {
    fetch,
    headers: { accept: "application/json", ...headers },
    timeout,
    retry,
    signal,
  });
  assertOk(response, options.operation ?? url.toString());
  return parseJsonResponse(response, options.operation ?? url.toString());
}

/** GET a URL as text (HTML grids, JSONP, anything not-quite-JSON). */
export async function getText(url, options = {}) {
  const { fetch, headers, timeout, retry, signal } = options;
  const response = await fetchWithRetry(url, {
    fetch,
    headers: { accept: "text/html,application/json;q=0.9,*/*;q=0.8", ...headers },
    timeout,
    retry,
    signal,
  });
  assertOk(response, options.operation ?? url.toString());
  return readBodyText(response, { label: options.operation ?? url.toString() });
}

/**
 * Walk numeric pages until `isDone(result)` is true or `maxPages` is hit.
 * `fetchPage(page)` returns one awaited page result; `onPage(result)` may
 * collect it. The walker never swallows fetch errors.
 */
export async function collectPages({ fetchPage, isDone, maxPages = Number.POSITIVE_INFINITY, onPage }) {
  const results = [];
  for (let page = 1; page <= maxPages; page += 1) {
    const result = await fetchPage(page);
    results.push(result);
    onPage?.(result, page);
    if (isDone?.(result, page)) break;
  }
  return results;
}

/** Human display store descriptor shared by all campaign clients. */
export function onlineStore({ slug, scopeId = "online", scopeName, origin, region }) {
  return {
    id: `${slug}:${scopeId}`,
    retailer: slug,
    name: scopeName ?? `${slug} online`,
    ...(region ? { region } : {}),
    ...(origin ? { origin } : {}),
  };
}
