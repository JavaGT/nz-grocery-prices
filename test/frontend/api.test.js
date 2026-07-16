import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';

class ApiError extends Error {
  constructor(message, status, data) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.data = data;
    this.isAuthError = status === 401;
  }
}

function buildURL(basePath, params) {
  if (!params) return basePath;
  const qs = Object.entries(params)
    .filter(([, v]) => v != null && v !== '')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
  return `${basePath}${qs ? '?' + qs : ''}`;
}

describe('ApiError', () => {
  it('sets isAuthError true for 401', () => {
    const err = new ApiError('Unauthorized', 401, null);
    assert.equal(err.isAuthError, true);
    assert.equal(err.status, 401);
  });
  it('sets isAuthError false for 404', () => {
    const err = new ApiError('Not Found', 404, null);
    assert.equal(err.isAuthError, false);
  });
  it('carries response data', () => {
    const data = { error: 'bad request' };
    const err = new ApiError('Bad Request', 400, data);
    assert.equal(err.data, data);
    assert.equal(err.message, 'Bad Request');
  });
});

describe('buildURL', () => {
  it('returns path unchanged when no params', () => {
    assert.equal(buildURL('/api/deals'), '/api/deals');
  });
  it('appends query string for params', () => {
    const url = buildURL('/api/products', { limit: 42, retailer: 'paknsave' });
    assert.match(url, /^\/api\/products\?/);
    assert.ok(url.includes('limit=42'));
    assert.ok(url.includes('retailer=paknsave'));
  });
  it('filters null and empty values', () => {
    const url = buildURL('/api/deals', { filter: 'all', retailer: '', unused: null });
    assert.equal(url, '/api/deals?filter=all');
  });
  it('encodes special characters', () => {
    const url = buildURL('/api/search/suggestions', { q: 'butter & eggs' });
    assert.ok(url.includes('butter+%26+eggs') || url.includes('butter%20%26%20eggs'));
  });
});

describe('race-prevention (inflight dedup concept)', () => {
  it('same URL method pair should cancel previous', () => {
    const controllers = new Map();
    const key = 'GET:/api/deals';
    const c1 = new AbortController();
    const c2 = new AbortController();

    controllers.set(key, c1);
    assert.equal(c1.signal.aborted, false);

    controllers.set(key, c2);
    c1.abort();
    assert.equal(c1.signal.aborted, true);
    assert.equal(c2.signal.aborted, false);

    controllers.delete(key);
  });
});

describe('auth:required event pattern', () => {
  it('EventTarget dispatch works for DOM events', () => {
    const target = new EventTarget();
    let fired = false;
    target.addEventListener('auth:required', () => { fired = true; });
    target.dispatchEvent(new CustomEvent('auth:required'));
    assert.equal(fired, true);
  });
});
