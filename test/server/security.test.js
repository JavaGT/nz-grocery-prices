import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createTestServer, productRec, storeRec } from './server-helpers.js';

async function fetchJson(url, options = {}) {
  const res = await fetch(url, options);
  let body = null;
  try {
    const text = await res.text();
    if (text) body = JSON.parse(text);
  } catch {}
  return { status: res.status, headers: res.headers, body };
}

function extractSid(headers) {
  const setCookie = headers.get('set-cookie');
  if (!setCookie) return null;
  const m = setCookie.match(/sid=([^;]+)/);
  return m ? m[1] : null;
}

async function registerAndLogin(baseUrl, username, password) {
  await fetchJson(`${baseUrl}/api/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  const login = await fetchJson(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  const sid = extractSid(login.headers);
  return { sid, user: login.body.user };
}

describe('security audit regression', () => {
  describe('rate limiting', () => {
    it('rejects rapid register attempts with 429', async () => {
      const srv = await createTestServer({ records: [] });
      try {
        const { baseUrl } = srv;
        for (let i = 0; i < 6; i++) {
          const res = await fetchJson(`${baseUrl}/api/auth/register`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ username: `ratelimit${i}`, password: 'password123' }),
          });
          if (i < 5) {
            assert.ok(res.status === 200, `request ${i} should succeed, got ${res.status}`);
          } else {
            assert.equal(res.status, 429, '6th register should be rate limited');
            assert.equal(res.body.error.code, 'RATE_LIMITED');
            assert.ok(res.headers.get('retry-after'), '429 should include Retry-After');
          }
        }
      } finally {
        await srv.close();
      }
    });

    it('rejects rapid login attempts with 429', async () => {
      const srv = await createTestServer({ records: [] });
      try {
        const { baseUrl } = srv;
        await fetchJson(`${baseUrl}/api/auth/register`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ username: 'loginrateuser', password: 'password123' }),
        });
        for (let i = 0; i < 21; i++) {
          const res = await fetchJson(`${baseUrl}/api/auth/login`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ username: 'loginrateuser', password: i < 20 ? 'password123' : 'wrongpw' }),
          });
          if (i < 20) {
            assert.ok(res.status === 200 || res.status === 401, `request ${i} should not be 429`);
          } else {
            assert.equal(res.status, 429, `21st login should be rate limited`);
          }
        }
      } finally {
        await srv.close();
      }
    });

    it('429 response includes Retry-After header', async () => {
      const srv = await createTestServer({ records: [] });
      try {
        const { baseUrl } = srv;
        for (let i = 0; i < 6; i++) {
          const res = await fetchJson(`${baseUrl}/api/auth/register`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ username: `retrytest${i}`, password: 'password123' }),
          });
          if (res.status === 429) {
            const retryAfter = res.headers.get('retry-after');
            assert.ok(retryAfter, '429 must have Retry-After header');
            const seconds = parseInt(retryAfter, 10);
            assert.ok(seconds > 0 && seconds <= 120, 'Retry-After must be reasonable');
          }
        }
      } finally {
        await srv.close();
      }
    });
  });

  describe('CSRF protection', () => {
    it('rejects mutating request with mismatched origin port', async () => {
      const srv = await createTestServer({ records: [] });
      try {
        const { baseUrl } = srv;
        const url = new URL(baseUrl);
        const { sid } = await registerAndLogin(baseUrl, 'csrfport', 'password123');
        const res = await fetchJson(`${baseUrl}/api/watch-list`, {
          method: 'POST',
          headers: {
            cookie: `sid=${sid}`,
            'content-type': 'application/json',
            origin: `http://${url.hostname}:9999`,
            host: url.host,
          },
          body: JSON.stringify({ targetKind: 'product', targetId: 'paknsave:test', label: 'Test' }),
        });
        assert.equal(res.status, 403);
        assert.equal(res.body.error.code, 'CSRF_REJECTED');
      } finally {
        await srv.close();
      }
    });

    it('rejects request with entirely different origin hostname', async () => {
      const srv = await createTestServer({ records: [] });
      try {
        const { baseUrl } = srv;
        const url = new URL(baseUrl);
        const { sid } = await registerAndLogin(baseUrl, 'csrfhost', 'password123');
        const res = await fetchJson(`${baseUrl}/api/watch-list`, {
          method: 'POST',
          headers: {
            cookie: `sid=${sid}`,
            'content-type': 'application/json',
            origin: 'https://evil.example.com',
            host: url.host,
          },
          body: JSON.stringify({ targetKind: 'product', targetId: 'paknsave:test', label: 'Test' }),
        });
        assert.equal(res.status, 403);
      } finally {
        await srv.close();
      }
    });
  });

  describe('cookie security', () => {
    it('sid cookie is HttpOnly and SameSite=Strict', async () => {
      const srv = await createTestServer({ records: [] });
      try {
        const { baseUrl } = srv;
        await fetchJson(`${baseUrl}/api/auth/register`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ username: 'cookieuser', password: 'password123' }),
        });
        const login = await fetchJson(`${baseUrl}/api/auth/login`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ username: 'cookieuser', password: 'password123' }),
        });
        const setCookie = login.headers.get('set-cookie');
        assert.ok(setCookie.includes('HttpOnly'), 'cookie must be HttpOnly');
        assert.ok(setCookie.includes('SameSite=Strict'), 'cookie must be SameSite=Strict');
        assert.ok(setCookie.includes('Path=/'), 'cookie must have Path=/');
        assert.ok(!setCookie.includes('Secure'), 'Secure should not be set on localhost without env');
      } finally {
        await srv.close();
      }
    });

    it('invalid session token format is ignored (treated as no cookie)', async () => {
      const srv = await createTestServer({ records: [] });
      try {
        const { baseUrl } = srv;
        const res = await fetchJson(`${baseUrl}/api/watch-list`, {
          headers: { cookie: 'sid=not-a-valid-hex-token' },
        });
        assert.equal(res.status, 401);
      } finally {
        await srv.close();
      }
    });

    it('session token is 64 hex characters', async () => {
      const srv = await createTestServer({ records: [] });
      try {
        const { baseUrl } = srv;
        await fetchJson(`${baseUrl}/api/auth/register`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ username: 'tokenuser', password: 'password123' }),
        });
        const login = await fetchJson(`${baseUrl}/api/auth/login`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ username: 'tokenuser', password: 'password123' }),
        });
        const m = login.headers.get('set-cookie').match(/sid=([^;]+)/);
        assert.ok(m, 'sid cookie must be present');
        assert.equal(m[1].length, 64, 'token must be 64 chars');
        assert.match(m[1], /^[a-f0-9]{64}$/, 'token must be 64 lowercase hex chars');
      } finally {
        await srv.close();
      }
    });

    it('token is not exposed in login response body', async () => {
      const srv = await createTestServer({ records: [] });
      try {
        const { baseUrl } = srv;
        await fetchJson(`${baseUrl}/api/auth/register`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ username: 'noleakuser', password: 'password123' }),
        });
        const login = await fetchJson(`${baseUrl}/api/auth/login`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ username: 'noleakuser', password: 'password123' }),
        });
        assert.ok(!login.body.token, 'token must not be in JSON body');
        assert.ok(!login.body.password_hash, 'password hash must not be in JSON body');
        const bodyStr = JSON.stringify(login.body);
        const m = login.headers.get('set-cookie').match(/sid=([^;]+)/);
        assert.ok(!bodyStr.includes(m[1]), 'raw token must not leak in response body');
      } finally {
        await srv.close();
      }
    });
  });

  describe('Secure cookie flag', () => {
    it('Secure flag not set without HTTPS and without TRUST_PROXY_HEADERS', async () => {
      const srv = await createTestServer({ records: [] });
      try {
        const { baseUrl } = srv;
        await fetchJson(`${baseUrl}/api/auth/register`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ username: 'secureuser', password: 'password123' }),
        });
        const login = await fetchJson(`${baseUrl}/api/auth/login`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-forwarded-proto': 'https',
          },
          body: JSON.stringify({ username: 'secureuser', password: 'password123' }),
        });
        const setCookie = login.headers.get('set-cookie');
        assert.ok(!setCookie.includes('Secure'), 'Secure must not be set when TRUST_PROXY_HEADERS is not enabled');
      } finally {
        await srv.close();
      }
    });
  });

  describe('product matches filtering', () => {
    it('confirmed matches are returned and fuzzy candidates are excluded from matches', async () => {
      const srv = await createTestServer({
        records: [
          productRec('paknsave:milk'),
          productRec('newworld:milk'),
          productRec('warehouse:milk'),
          storeRec('paknsave:royaloak'),
          storeRec('newworld:auckland'),
          storeRec('warehouse:national'),
        ],
        appDbInit: (appDb) => {
          appDb.createMatchPair({
            productAId: 'newworld:milk', productBId: 'paknsave:milk',
            matchMethod: 'auto_gtin', algorithmVersion: '1.0.0',
            confidence: 1.0, reviewState: 'confirmed', provenance: 'system', inputEvidenceHash: 'h1',
          });
          appDb.createMatchPair({
            productAId: 'warehouse:milk', productBId: 'paknsave:milk',
            matchMethod: 'fuzzy_candidate', algorithmVersion: '1.0.0',
            confidence: 0.5, reviewState: 'candidate', provenance: 'system', inputEvidenceHash: 'h2',
          });
        },
      });
      try {
        const { status, body } = await fetchJson(`${srv.baseUrl}/api/products/paknsave:milk`);
        assert.equal(status, 200);
        assert.equal(body.matches.length, 1, 'only confirmed matches returned');
        assert.equal(body.matches[0].method, 'auto_gtin');
        assert.equal(body.candidates.length, 1, 'fuzzy candidates returned separately');
        assert.equal(body.candidates[0].method, 'fuzzy_candidate');
      } finally {
        await srv.close();
      }
    });
  });

  describe('error responses', () => {
    it('do not expose stack traces', async () => {
      const srv = await createTestServer({ records: [] });
      try {
        const { baseUrl } = srv;
        const res = await fetchJson(`${baseUrl}/api/nonexistent-route`);
        assert.ok(!res.body.stack, 'stack trace must not be exposed');
        assert.ok(!res.body.error?.stack, 'stack trace must not be in error');
      } finally {
        await srv.close();
      }
    });

    it('do not expose SQL details', async () => {
      const srv = await createTestServer({ records: [] });
      try {
        const { baseUrl } = srv;
        const res = await fetchJson(`${baseUrl}/api/auth/login`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ username: 'nonexistent@user', password: 'test12345' }),
        });
        const bodyStr = JSON.stringify(res.body).toLowerCase();
        assert.ok(!bodyStr.includes('sql'), 'SQL details must not leak');
        assert.ok(!bodyStr.includes('select'), 'SQL must not leak');
        assert.ok(!bodyStr.includes('insert'), 'SQL must not leak');
        assert.ok(!bodyStr.includes('database'), 'DB details must not leak');
      } finally {
        await srv.close();
      }
    });

    it('no username enumeration in login error', async () => {
      const srv = await createTestServer({ records: [] });
      try {
        const { baseUrl } = srv;

        await fetchJson(`${baseUrl}/api/auth/register`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ username: 'enumuser', password: 'password123' }),
        });

        const wrongPw = await fetchJson(`${baseUrl}/api/auth/login`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ username: 'enumuser', password: 'wrongpassword' }),
        });
        assert.equal(wrongPw.status, 401);
        assert.equal(wrongPw.body.error.code, 'INVALID_CREDENTIALS');
        assert.equal(wrongPw.body.error.message, 'Invalid credentials');

        const noUser = await fetchJson(`${baseUrl}/api/auth/login`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ username: 'nonexistent_user', password: 'password123' }),
        });
        assert.equal(noUser.status, 401);
        assert.equal(noUser.body.error.code, 'INVALID_CREDENTIALS');
        assert.equal(noUser.body.error.message, 'Invalid credentials');
      } finally {
        await srv.close();
      }
    });
  });

  describe('headers', () => {
    it('error responses have stable JSON content type', async () => {
      const srv = await createTestServer({ records: [] });
      try {
        const { baseUrl } = srv;
        const endpoints = [
          { path: '/api/nonexistent', status: 404 },
          { path: '/api/products?query=' + 'x'.repeat(201), status: 400 },
          { path: '/api/search/suggestions?query=a', status: 400 },
        ];
        for (const ep of endpoints) {
          const res = await fetch(`${baseUrl}${ep.path}`);
          assert.equal(res.status, ep.status);
          const ct = res.headers.get('content-type') || '';
          assert.ok(ct.startsWith('application/json'), `endpoint ${ep.path} has content-type: ${ct}`);
        }
      } finally {
        await srv.close();
      }
    });

    it('responses include _requestId and _freshness on error responses', async () => {
      const srv = await createTestServer({ records: [] });
      try {
        const { baseUrl } = srv;
        const { body } = await fetchJson(`${baseUrl}/api/nonexistent`);
        assert.ok(body._requestId);
        assert.ok(body._freshness);
      } finally {
        await srv.close();
      }
    });

    it('x-content-type-options nosniff on all API responses', async () => {
      const srv = await createTestServer({ records: [] });
      try {
        const { baseUrl } = srv;
        const res = await fetch(`${baseUrl}/api/health`);
        assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
      } finally {
        await srv.close();
      }
    });

    it('x-frame-options SAMEORIGIN on API responses', async () => {
      const srv = await createTestServer({ records: [] });
      try {
        const { baseUrl } = srv;
        const res = await fetch(`${baseUrl}/api/health`);
        assert.equal(res.headers.get('x-frame-options'), 'SAMEORIGIN');
      } finally {
        await srv.close();
      }
    });
  });

  describe('password hashing', () => {
    it('password hash is never returned in any response', async () => {
      const srv = await createTestServer({ records: [] });
      try {
        const { baseUrl } = srv;
        const reg = await fetchJson(`${baseUrl}/api/auth/register`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ username: 'nohashuser', password: 'password123' }),
        });
        const bodyStr = JSON.stringify(reg.body);
        assert.ok(!bodyStr.includes('password_hash'), 'password_hash must not be in response');
        assert.ok(!bodyStr.includes('"password"'), 'password field must not be in response');
        assert.ok(!reg.body.user.password_hash, 'user object must not contain password_hash');
      } finally {
        await srv.close();
      }
    });
  });

  describe('username enumeration resistance', () => {
    it('existing user wrong password vs nonexistent user both get 401 with same message', async () => {
      const srv = await createTestServer({ records: [] });
      try {
        const { baseUrl } = srv;
        await fetchJson(`${baseUrl}/api/auth/register`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ username: 'targetuser', password: 'password123' }),
        });
        const existing = await fetchJson(`${baseUrl}/api/auth/login`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ username: 'targetuser', password: 'wrongpass' }),
        });
        const nonexistent = await fetchJson(`${baseUrl}/api/auth/login`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ username: 'nobody', password: 'password123' }),
        });
        assert.equal(existing.status, 401);
        assert.equal(nonexistent.status, 401);
        assert.equal(existing.body.error.code, nonexistent.body.error.code);
        assert.equal(existing.body.error.message, nonexistent.body.error.message);
      } finally {
        await srv.close();
      }
    });
  });

  describe('body size limits', () => {
    it('rejects oversized bodies > 64KB with 413', async () => {
      const srv = await createTestServer({ records: [] });
      try {
        const { baseUrl } = srv;
        const { sid } = await registerAndLogin(baseUrl, 'sizelimit', 'password123');
        const largeLabel = 'x'.repeat(65536);
        const res = await fetchJson(`${baseUrl}/api/watch-list`, {
          method: 'POST',
          headers: {
            cookie: `sid=${sid}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({ targetKind: 'product', targetId: 'paknsave:test', label: largeLabel }),
        });
        assert.equal(res.status, 413);
      } finally {
        await srv.close();
      }
    });
  });
});
