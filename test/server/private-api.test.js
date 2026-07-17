import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestServer, hash } from './server-helpers.js';

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

async function registerAndLogin(baseUrl, username = 'testuser', password = 'testpass123') {
  const reg = await fetchJson(`${baseUrl}/api/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  assert.equal(reg.status, 200);
  const login = await fetchJson(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  assert.equal(login.status, 200);
  const sid = extractSid(login.headers);
  assert.ok(sid, 'login should set sid cookie');
  return { sid, user: login.body.user };
}

function authHeaders(sid) {
  return { cookie: `sid=${sid}`, 'content-type': 'application/json' };
}

describe('private API', () => {
  describe('auth endpoints', () => {
    it('full auth roundtrip: register, login, cookie attributes, logout', async () => {
      const srv = await createTestServer({ records: [] });
      try {
        const { baseUrl } = srv;

        const reg = await fetchJson(`${baseUrl}/api/auth/register`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ username: 'alice', password: 'password123' }),
        });
        assert.equal(reg.status, 200);
        assert.ok(reg.body.user);
        assert.equal(reg.body.user.username, 'alice');
        assert.ok(reg.body.user.id);
        assert.ok(!reg.body.user.password_hash);
        assert.ok(reg.body._requestId);
        assert.ok(reg.body._freshness);

        const login = await fetchJson(`${baseUrl}/api/auth/login`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ username: 'alice', password: 'password123' }),
        });
        assert.equal(login.status, 200);
        assert.equal(login.body.user.username, 'alice');
        assert.ok(!login.body.token, 'token should not be in JSON body');

        const setCookie = login.headers.get('set-cookie');
        assert.ok(setCookie, 'login should set set-cookie header');
        assert.ok(setCookie.includes('HttpOnly'), 'cookie should be HttpOnly');
        assert.ok(setCookie.includes('SameSite=Strict'), 'cookie should be SameSite=Strict');
        assert.ok(setCookie.includes('Path=/'), 'cookie should have Path=/');
        assert.ok(setCookie.includes('Max-Age='), 'cookie should have Max-Age');

        const sid = extractSid(login.headers);
        assert.ok(sid, 'sid cookie value should be present');
        assert.equal(sid.length, 64, 'sid should be 64 hex chars');

        const loginBodyStr = JSON.stringify(login.body);
        assert.ok(!loginBodyStr.includes(sid), 'token should not leak in login response body');

        const logout = await fetchJson(`${baseUrl}/api/auth/logout`, {
          method: 'POST',
          headers: { cookie: `sid=${sid}` },
        });
        assert.equal(logout.status, 200);
        const logoutCookie = logout.headers.get('set-cookie');
        assert.ok(logoutCookie, 'logout should set empty cookie');
        assert.ok(logoutCookie.includes('Max-Age=0'), 'logout cookie should have Max-Age=0');

        const watchRes = await fetchJson(`${baseUrl}/api/watch-list`, {
          headers: { cookie: `sid=${sid}` },
        });
        assert.equal(watchRes.status, 401, 'should be 401 after logout');
      } finally {
        await srv.close();
      }
    });

    it('me returns the session user and 401 without a session', async () => {
      const srv = await createTestServer({ records: [] });
      try {
        const { baseUrl } = srv;

        const anonymous = await fetchJson(`${baseUrl}/api/auth/me`);
        assert.equal(anonymous.status, 401, 'anonymous probe should be 401');

        const { sid, user } = await registerAndLogin(baseUrl, 'carol', 'password123');
        const me = await fetchJson(`${baseUrl}/api/auth/me`, {
          headers: { cookie: `sid=${sid}` },
        });
        assert.equal(me.status, 200);
        assert.equal(me.body.user.username, 'carol');
        assert.equal(me.body.user.id, user.id);
        assert.ok(!me.body.user.password_hash);

        await fetchJson(`${baseUrl}/api/auth/logout`, {
          method: 'POST',
          headers: { cookie: `sid=${sid}` },
        });
        const after = await fetchJson(`${baseUrl}/api/auth/me`, {
          headers: { cookie: `sid=${sid}` },
        });
        assert.equal(after.status, 401, 'probe should be 401 after logout');
      } finally {
        await srv.close();
      }
    });

    it('register rejects duplicate username', async () => {
      const srv = await createTestServer({ records: [] });
      try {
        const { baseUrl } = srv;
        await fetchJson(`${baseUrl}/api/auth/register`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ username: 'bob', password: 'password123' }),
        });
        const dup = await fetchJson(`${baseUrl}/api/auth/register`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ username: 'bob', password: 'different456' }),
        });
        assert.equal(dup.status, 409);
        assert.equal(dup.body.error.code, 'USERNAME_TAKEN');
      } finally {
        await srv.close();
      }
    });

    it('register rejects duplicate by case-insensitivity', async () => {
      const srv = await createTestServer({ records: [] });
      try {
        const { baseUrl } = srv;
        await fetchJson(`${baseUrl}/api/auth/register`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ username: 'Charlie', password: 'password123' }),
        });
        const dup = await fetchJson(`${baseUrl}/api/auth/register`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ username: 'charlie', password: 'different456' }),
        });
        assert.equal(dup.status, 409);
      } finally {
        await srv.close();
      }
    });

    it('login returns 401 for wrong password', async () => {
      const srv = await createTestServer({ records: [] });
      try {
        const { baseUrl } = srv;
        await fetchJson(`${baseUrl}/api/auth/register`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ username: 'diana', password: 'correctPW123' }),
        });
        const bad = await fetchJson(`${baseUrl}/api/auth/login`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ username: 'diana', password: 'wrongPW456' }),
        });
        assert.equal(bad.status, 401);
        assert.equal(bad.body.error.code, 'INVALID_CREDENTIALS');
      } finally {
        await srv.close();
      }
    });

    it('login returns 401 for nonexistent user', async () => {
      const srv = await createTestServer({ records: [] });
      try {
        const { baseUrl } = srv;
        const res = await fetchJson(`${baseUrl}/api/auth/login`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ username: 'nobody', password: 'password123' }),
        });
        assert.equal(res.status, 401);
      } finally {
        await srv.close();
      }
    });

    it('register rejects short username', async () => {
      const srv = await createTestServer({ records: [] });
      try {
        const { baseUrl } = srv;
        const res = await fetchJson(`${baseUrl}/api/auth/register`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ username: 'ab', password: 'password123' }),
        });
        assert.equal(res.status, 400);
      } finally {
        await srv.close();
      }
    });

    it('register rejects short password', async () => {
      const srv = await createTestServer({ records: [] });
      try {
        const { baseUrl } = srv;
        const res = await fetchJson(`${baseUrl}/api/auth/register`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ username: 'eve', password: 'short' }),
        });
        assert.equal(res.status, 400);
      } finally {
        await srv.close();
      }
    });

    it('register rejects long password', async () => {
      const srv = await createTestServer({ records: [] });
      try {
        const { baseUrl } = srv;
        const res = await fetchJson(`${baseUrl}/api/auth/register`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ username: 'frank', password: 'x'.repeat(257) }),
        });
        assert.equal(res.status, 400);
      } finally {
        await srv.close();
      }
    });

    it('logout is idempotent', async () => {
      const srv = await createTestServer({ records: [] });
      try {
        const { baseUrl } = srv;
        const { sid } = await registerAndLogin(baseUrl, 'grace', 'password123');
        const r1 = await fetchJson(`${baseUrl}/api/auth/logout`, {
          method: 'POST', headers: { cookie: `sid=${sid}` },
        });
        assert.equal(r1.status, 200);
        const r2 = await fetchJson(`${baseUrl}/api/auth/logout`, {
          method: 'POST', headers: { cookie: `sid=${sid}` },
        });
        assert.equal(r2.status, 200);
      } finally {
        await srv.close();
      }
    });

    it('register rejects username starting with non-letter', async () => {
      const srv = await createTestServer({ records: [] });
      try {
        const { baseUrl } = srv;
        const r1 = await fetchJson(`${baseUrl}/api/auth/register`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ username: '1invalid', password: 'password123' }),
        });
        assert.equal(r1.status, 400);
        const r2 = await fetchJson(`${baseUrl}/api/auth/register`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ username: '_underscore', password: 'password123' }),
        });
        assert.equal(r2.status, 400);
      } finally {
        await srv.close();
      }
    });

    it('login accepts case-insensitive username', async () => {
      const srv = await createTestServer({ records: [] });
      try {
        const { baseUrl } = srv;
        await fetchJson(`${baseUrl}/api/auth/register`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ username: 'Heidi', password: 'mypassword' }),
        });
        const login = await fetchJson(`${baseUrl}/api/auth/login`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ username: 'heidi', password: 'mypassword' }),
        });
        assert.equal(login.status, 200);
        assert.equal(login.body.user.username, 'Heidi');
      } finally {
        await srv.close();
      }
    });
  });

  describe('401 unauthenticated access', () => {
    it('returns 401 for private endpoints without cookie', async () => {
      const srv = await createTestServer({ records: [] });
      try {
        const { baseUrl } = srv;
        const endpoints = [
          { method: 'GET', path: '/api/watch-list' },
          { method: 'POST', path: '/api/watch-list', body: {} },
          { method: 'GET', path: '/api/preferred-stores' },
          { method: 'POST', path: '/api/preferred-stores', body: {} },
          { method: 'GET', path: '/api/saved-searches' },
          { method: 'POST', path: '/api/saved-searches', body: {} },
          { method: 'GET', path: '/api/new-products' },
        ];
        for (const ep of endpoints) {
          const res = await fetchJson(`${baseUrl}${ep.path}`, {
            method: ep.method,
            headers: { 'content-type': 'application/json' },
            body: ep.body ? JSON.stringify(ep.body) : undefined,
          });
          assert.equal(res.status, 401, `expected 401 for ${ep.method} ${ep.path}`);
        }
      } finally {
        await srv.close();
      }
    });

    it('returns 401 for invalid session token', async () => {
      const srv = await createTestServer({ records: [] });
      try {
        const { baseUrl } = srv;
        const res = await fetchJson(`${baseUrl}/api/watch-list`, {
          headers: { cookie: 'sid=invalidtoken123' },
        });
        assert.equal(res.status, 401);
      } finally {
        await srv.close();
      }
    });
  });

  describe('watch list', () => {
    it('returns entries for authenticated user', async () => {
      const srv = await createTestServer({ records: [] });
      try {
        const { baseUrl } = srv;
        const { sid } = await registerAndLogin(baseUrl, 'watchuser1', 'password123');
        const res = await fetchJson(`${baseUrl}/api/watch-list`, {
          headers: authHeaders(sid),
        });
        assert.equal(res.status, 200);
        assert.ok(Array.isArray(res.body));
      } finally {
        await srv.close();
      }
    });

    it('add and list watch entries', async () => {
      const srv = await createTestServer({ records: [] });
      try {
        const { baseUrl } = srv;
        const { sid } = await registerAndLogin(baseUrl, 'watchuser2', 'password123');

        const add1 = await fetchJson(`${baseUrl}/api/watch-list`, {
          method: 'POST',
          headers: authHeaders(sid),
          body: JSON.stringify({ targetKind: 'product', targetId: 'paknsave:milk', label: 'Milk 1L' }),
        });
        assert.equal(add1.status, 200);

        const add2 = await fetchJson(`${baseUrl}/api/watch-list`, {
          method: 'POST',
          headers: authHeaders(sid),
          body: JSON.stringify({ targetKind: 'product', targetId: 'paknsave:bread', label: 'White Bread' }),
        });
        assert.equal(add2.status, 200);

        const list = await fetchJson(`${baseUrl}/api/watch-list`, {
          headers: authHeaders(sid),
        });
        assert.equal(list.status, 200);
        assert.ok(Array.isArray(list.body));
        assert.equal(list.body.length, 2);
      } finally {
        await srv.close();
      }
    });

    it('delete watch entry by id', async () => {
      const srv = await createTestServer({ records: [] });
      try {
        const { baseUrl } = srv;
        const { sid } = await registerAndLogin(baseUrl, 'watchuser3', 'password123');

        const add = await fetchJson(`${baseUrl}/api/watch-list`, {
          method: 'POST',
          headers: authHeaders(sid),
          body: JSON.stringify({ targetKind: 'product', targetId: 'paknsave:milk', label: 'Milk' }),
        });
        const entryId = add.body.id;

        const del = await fetchJson(`${baseUrl}/api/watch-list/${entryId}`, {
          method: 'DELETE',
          headers: authHeaders(sid),
        });
        assert.equal(del.status, 200);

        const list = await fetchJson(`${baseUrl}/api/watch-list`, {
          headers: authHeaders(sid),
        });
        assert.equal(list.body.length, 0);
      } finally {
        await srv.close();
      }
    });

    it('cannot delete another user\'s watch entry', async () => {
      const srv = await createTestServer({ records: [] });
      try {
        const { baseUrl } = srv;
        const { sid: sidA } = await registerAndLogin(baseUrl, 'userA', 'password123');
        const { sid: sidB } = await registerAndLogin(baseUrl, 'userB', 'password123');

        const add = await fetchJson(`${baseUrl}/api/watch-list`, {
          method: 'POST',
          headers: authHeaders(sidA),
          body: JSON.stringify({ targetKind: 'product', targetId: 'paknsave:milk', label: 'Milk' }),
        });
        const entryId = add.body.id;

        const del = await fetchJson(`${baseUrl}/api/watch-list/${entryId}`, {
          method: 'DELETE',
          headers: authHeaders(sidB),
        });
        assert.equal(del.status, 404);
      } finally {
        await srv.close();
      }
    });

    it('rejects add with invalid targetKind', async () => {
      const srv = await createTestServer({ records: [] });
      try {
        const { baseUrl } = srv;
        const { sid } = await registerAndLogin(baseUrl, 'watchuser4', 'password123');
        const res = await fetchJson(`${baseUrl}/api/watch-list`, {
          method: 'POST',
          headers: authHeaders(sid),
          body: JSON.stringify({ targetKind: 'invalid', targetId: 'x', label: 'x' }),
        });
        assert.equal(res.status, 400);
      } finally {
        await srv.close();
      }
    });

    it('rejects add with empty targetId', async () => {
      const srv = await createTestServer({ records: [] });
      try {
        const { baseUrl } = srv;
        const { sid } = await registerAndLogin(baseUrl, 'watchuser5', 'password123');
        const res = await fetchJson(`${baseUrl}/api/watch-list`, {
          method: 'POST',
          headers: authHeaders(sid),
          body: JSON.stringify({ targetKind: 'product', targetId: '', label: 'x' }),
        });
        assert.equal(res.status, 400);
      } finally {
        await srv.close();
      }
    });

    it('rejects invalid product ID format in watch entry', async () => {
      const srv = await createTestServer({ records: [] });
      try {
        const { baseUrl } = srv;
        const { sid } = await registerAndLogin(baseUrl, 'watchuser6', 'password123');
        const res = await fetchJson(`${baseUrl}/api/watch-list`, {
          method: 'POST',
          headers: authHeaders(sid),
          body: JSON.stringify({
            targetKind: 'product',
            targetId: "prod:' OR '1'='1",
            label: "Test's label with 'quotes'",
          }),
        });
        assert.equal(res.status, 400);
        assert.equal(res.body.error.code, 'VALIDATION_ERROR');
      } finally {
        await srv.close();
      }
    });
  });

  describe('preferred stores', () => {
    it('CRUD preferred stores', async () => {
      const srv = await createTestServer({ records: [] });
      try {
        const { baseUrl } = srv;
        const { sid } = await registerAndLogin(baseUrl, 'prefuser', 'password123');

        const set1 = await fetchJson(`${baseUrl}/api/preferred-stores`, {
          method: 'POST',
          headers: authHeaders(sid),
          body: JSON.stringify({ contextId: 1, rank: 1 }),
        });
        assert.equal(set1.status, 200);

        const set2 = await fetchJson(`${baseUrl}/api/preferred-stores`, {
          method: 'POST',
          headers: authHeaders(sid),
          body: JSON.stringify({ contextId: 2, rank: 2 }),
        });
        assert.equal(set2.status, 200);

        const list = await fetchJson(`${baseUrl}/api/preferred-stores`, {
          headers: authHeaders(sid),
        });
        assert.equal(list.status, 200);
        assert.ok(Array.isArray(list.body));
        assert.equal(list.body.length, 2);
      } finally {
        await srv.close();
      }
    });

    it('rank 0 removes preference', async () => {
      const srv = await createTestServer({ records: [] });
      try {
        const { baseUrl } = srv;
        const { sid } = await registerAndLogin(baseUrl, 'prefuser2', 'password123');

        await fetchJson(`${baseUrl}/api/preferred-stores`, {
          method: 'POST',
          headers: authHeaders(sid),
          body: JSON.stringify({ contextId: 5, rank: 1 }),
        });

        const setZero = await fetchJson(`${baseUrl}/api/preferred-stores`, {
          method: 'POST',
          headers: authHeaders(sid),
          body: JSON.stringify({ contextId: 5, rank: 0 }),
        });
        assert.equal(setZero.status, 200);

        const list = await fetchJson(`${baseUrl}/api/preferred-stores`, {
          headers: authHeaders(sid),
        });
        assert.equal(list.body.length, 0);
      } finally {
        await srv.close();
      }
    });

    it('delete preferred store by contextId', async () => {
      const srv = await createTestServer({ records: [] });
      try {
        const { baseUrl } = srv;
        const { sid } = await registerAndLogin(baseUrl, 'prefuser3', 'password123');

        await fetchJson(`${baseUrl}/api/preferred-stores`, {
          method: 'POST',
          headers: authHeaders(sid),
          body: JSON.stringify({ contextId: 10, rank: 1 }),
        });

        const del = await fetchJson(`${baseUrl}/api/preferred-stores/10`, {
          method: 'DELETE',
          headers: authHeaders(sid),
        });
        assert.equal(del.status, 200);

        const list = await fetchJson(`${baseUrl}/api/preferred-stores`, {
          headers: authHeaders(sid),
        });
        assert.equal(list.body.length, 0);
      } finally {
        await srv.close();
      }
    });

    it('rejects invalid contextId', async () => {
      const srv = await createTestServer({ records: [] });
      try {
        const { baseUrl } = srv;
        const { sid } = await registerAndLogin(baseUrl, 'prefuser4', 'password123');
        const res = await fetchJson(`${baseUrl}/api/preferred-stores`, {
          method: 'POST',
          headers: authHeaders(sid),
          body: JSON.stringify({ contextId: 'abc', rank: 1 }),
        });
        assert.ok(res.status === 400);
      } finally {
        await srv.close();
      }
    });
  });

  describe('saved searches', () => {
    it('CRUD saved searches', async () => {
      const srv = await createTestServer({ records: [] });
      try {
        const { baseUrl } = srv;
        const { sid } = await registerAndLogin(baseUrl, 'searchuser', 'password123');

        const create = await fetchJson(`${baseUrl}/api/saved-searches`, {
          method: 'POST',
          headers: authHeaders(sid),
          body: JSON.stringify({ name: 'Milk Deals', queryText: 'milk' }),
        });
        assert.equal(create.status, 200);
        assert.equal(create.body.name, 'Milk Deals');

        const list = await fetchJson(`${baseUrl}/api/saved-searches`, {
          headers: authHeaders(sid),
        });
        assert.equal(list.status, 200);
        assert.ok(Array.isArray(list.body));
        assert.equal(list.body.length, 1);
        assert.equal(list.body[0].name, 'Milk Deals');
        assert.equal(list.body[0].queryText, 'milk');

        const del = await fetchJson(`${baseUrl}/api/saved-searches/${create.body.id}`, {
          method: 'DELETE',
          headers: authHeaders(sid),
        });
        assert.equal(del.status, 200);

        const list2 = await fetchJson(`${baseUrl}/api/saved-searches`, {
          headers: authHeaders(sid),
        });
        assert.equal(list2.body.length, 0);
      } finally {
        await srv.close();
      }
    });

    it('rejects duplicate normalized search', async () => {
      const srv = await createTestServer({ records: [] });
      try {
        const { baseUrl } = srv;
        const { sid } = await registerAndLogin(baseUrl, 'searchuser2', 'password123');

        await fetchJson(`${baseUrl}/api/saved-searches`, {
          method: 'POST',
          headers: authHeaders(sid),
          body: JSON.stringify({ name: 'Eggs', queryText: 'eggs' }),
        });
        const dup = await fetchJson(`${baseUrl}/api/saved-searches`, {
          method: 'POST',
          headers: authHeaders(sid),
          body: JSON.stringify({ name: 'Eggs Again', queryText: 'EGGS' }),
        });
        assert.equal(dup.status, 409);
        assert.equal(dup.body.error.code, 'DUPLICATE_SEARCH');
      } finally {
        await srv.close();
      }
    });

    it('rejects empty name', async () => {
      const srv = await createTestServer({ records: [] });
      try {
        const { baseUrl } = srv;
        const { sid } = await registerAndLogin(baseUrl, 'searchuser3', 'password123');
        const res = await fetchJson(`${baseUrl}/api/saved-searches`, {
          method: 'POST',
          headers: authHeaders(sid),
          body: JSON.stringify({ name: '', queryText: 'test' }),
        });
        assert.equal(res.status, 400);
      } finally {
        await srv.close();
      }
    });

    it('rejects empty queryText', async () => {
      const srv = await createTestServer({ records: [] });
      try {
        const { baseUrl } = srv;
        const { sid } = await registerAndLogin(baseUrl, 'searchuser4', 'password123');
        const res = await fetchJson(`${baseUrl}/api/saved-searches`, {
          method: 'POST',
          headers: authHeaders(sid),
          body: JSON.stringify({ name: 'Test', queryText: '' }),
        });
        assert.equal(res.status, 400);
      } finally {
        await srv.close();
      }
    });

    it('rejects name > 100 chars', async () => {
      const srv = await createTestServer({ records: [] });
      try {
        const { baseUrl } = srv;
        const { sid } = await registerAndLogin(baseUrl, 'searchuser5', 'password123');
        const res = await fetchJson(`${baseUrl}/api/saved-searches`, {
          method: 'POST',
          headers: authHeaders(sid),
          body: JSON.stringify({ name: 'x'.repeat(101), queryText: 'test' }),
        });
        assert.equal(res.status, 400);
      } finally {
        await srv.close();
      }
    });

    it('ownership isolation for saved searches', async () => {
      const srv = await createTestServer({ records: [] });
      try {
        const { baseUrl } = srv;
        const { sid: sidA } = await registerAndLogin(baseUrl, 'searchA', 'password123');
        const { sid: sidB } = await registerAndLogin(baseUrl, 'searchB', 'password123');

        await fetchJson(`${baseUrl}/api/saved-searches`, {
          method: 'POST',
          headers: authHeaders(sidA),
          body: JSON.stringify({ name: 'A Search', queryText: 'aaa' }),
        });

        const bList = await fetchJson(`${baseUrl}/api/saved-searches`, {
          headers: authHeaders(sidB),
        });
        assert.equal(bList.body.length, 0);
      } finally {
        await srv.close();
      }
    });

    it('404 when deleting non-owned search', async () => {
      const srv = await createTestServer({ records: [] });
      try {
        const { baseUrl } = srv;
        const { sid: sidA } = await registerAndLogin(baseUrl, 'searchC', 'password123');
        const { sid: sidB } = await registerAndLogin(baseUrl, 'searchD', 'password123');

        const create = await fetchJson(`${baseUrl}/api/saved-searches`, {
          method: 'POST',
          headers: authHeaders(sidA),
          body: JSON.stringify({ name: 'C Search', queryText: 'ccc' }),
        });

        const del = await fetchJson(`${baseUrl}/api/saved-searches/${create.body.id}`, {
          method: 'DELETE',
          headers: authHeaders(sidB),
        });
        assert.equal(del.status, 404);
      } finally {
        await srv.close();
      }
    });
  });

  describe('new products', () => {
    it('returns empty array when no new products', async () => {
      const srv = await createTestServer({ records: [] });
      try {
        const { baseUrl } = srv;
        const { sid } = await registerAndLogin(baseUrl, 'newuser1', 'password123');
        const res = await fetchJson(`${baseUrl}/api/new-products`, {
          headers: authHeaders(sid),
        });
        assert.equal(res.status, 200);
        assert.ok(Array.isArray(res.body.products));
        assert.equal(res.body.products.length, 0);
        assert.ok(res.body.lastCheckedAt);
      } finally {
        await srv.close();
      }
    });
  });

  describe('ownership isolation across two users', () => {
    it('users see only their own watch list entries', async () => {
      const srv = await createTestServer({ records: [] });
      try {
        const { baseUrl } = srv;
        const { sid: sidA } = await registerAndLogin(baseUrl, 'isolationA', 'password123');
        const { sid: sidB } = await registerAndLogin(baseUrl, 'isolationB', 'password123');

        await fetchJson(`${baseUrl}/api/watch-list`, {
          method: 'POST',
          headers: authHeaders(sidA),
          body: JSON.stringify({ targetKind: 'product', targetId: 'paknsave:milk', label: 'Milk' }),
        });
        await fetchJson(`${baseUrl}/api/watch-list`, {
          method: 'POST',
          headers: authHeaders(sidA),
          body: JSON.stringify({ targetKind: 'product', targetId: 'paknsave:bread', label: 'Bread' }),
        });
        await fetchJson(`${baseUrl}/api/watch-list`, {
          method: 'POST',
          headers: authHeaders(sidB),
          body: JSON.stringify({ targetKind: 'product', targetId: 'paknsave:eggs', label: 'Eggs' }),
        });

        const listA = await fetchJson(`${baseUrl}/api/watch-list`, { headers: authHeaders(sidA) });
        assert.equal(listA.body.length, 2);

        const listB = await fetchJson(`${baseUrl}/api/watch-list`, { headers: authHeaders(sidB) });
        assert.equal(listB.body.length, 1);
        assert.equal(listB.body[0].target_id, 'paknsave:eggs');
      } finally {
        await srv.close();
      }
    });
  });

  describe('CSRF protection', () => {
    it('rejects mutating request with mismatched Origin', async () => {
      const srv = await createTestServer({ records: [] });
      try {
        const { baseUrl } = srv;
        const { sid } = await registerAndLogin(baseUrl, 'csrfuser', 'password123');
        const res = await fetchJson(`${baseUrl}/api/watch-list`, {
          method: 'POST',
          headers: {
            cookie: `sid=${sid}`,
            'content-type': 'application/json',
            origin: 'https://evil.example.com',
            host: new URL(baseUrl).host,
          },
          body: JSON.stringify({ targetKind: 'product', targetId: 'paknsave:test', label: 'Test' }),
        });
        assert.equal(res.status, 403);
        assert.equal(res.body.error.code, 'CSRF_REJECTED');
      } finally {
        await srv.close();
      }
    });

    it('allows mutating request with matching Origin', async () => {
      const srv = await createTestServer({ records: [] });
      try {
        const { baseUrl } = srv;
        const url = new URL(baseUrl);
        const { sid } = await registerAndLogin(baseUrl, 'csrfuser2', 'password123');
        const res = await fetchJson(`${baseUrl}/api/watch-list`, {
          method: 'POST',
          headers: {
            cookie: `sid=${sid}`,
            'content-type': 'application/json',
            origin: `http://${url.host}`,
            host: url.host,
          },
          body: JSON.stringify({ targetKind: 'product', targetId: 'paknsave:test', label: 'Test' }),
        });
        assert.equal(res.status, 200);
      } finally {
        await srv.close();
      }
    });

    it('allows mutating request without Origin header', async () => {
      const srv = await createTestServer({ records: [] });
      try {
        const { baseUrl } = srv;
        const { sid } = await registerAndLogin(baseUrl, 'csrfuser3', 'password123');
        const res = await fetchJson(`${baseUrl}/api/watch-list`, {
          method: 'POST',
          headers: authHeaders(sid),
          body: JSON.stringify({ targetKind: 'product', targetId: 'paknsave:test', label: 'Test' }),
        });
        assert.equal(res.status, 200);
      } finally {
        await srv.close();
      }
    });
  });

  describe('request validation', () => {
    it('rejects oversized body (> 64KB)', async () => {
      const srv = await createTestServer({ records: [] });
      try {
        const { baseUrl } = srv;
        const { sid } = await registerAndLogin(baseUrl, 'sizeuser', 'password123');
        const largeBody = { targetKind: 'product', targetId: 'paknsave:test', label: 'x'.repeat(70000) };
        const res = await fetchJson(`${baseUrl}/api/watch-list`, {
          method: 'POST',
          headers: authHeaders(sid),
          body: JSON.stringify(largeBody),
        });
        assert.equal(res.status, 413);
      } finally {
        await srv.close();
      }
    });

    it('rejects invalid JSON body', async () => {
      const srv = await createTestServer({ records: [] });
      try {
        const { baseUrl } = srv;
        const res = await fetch(`${baseUrl}/api/auth/register`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: 'not-json',
        });
        assert.equal(res.status, 400);
        const body = await res.json();
        assert.equal(body.error.code, 'INVALID_JSON');
      } finally {
        await srv.close();
      }
    });

    it('rejects missing body fields for login', async () => {
      const srv = await createTestServer({ records: [] });
      try {
        const { baseUrl } = srv;
        const res = await fetchJson(`${baseUrl}/api/auth/login`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({}),
        });
        assert.equal(res.status, 400);
      } finally {
        await srv.close();
      }
    });
  });

  describe('session expiry', () => {
    it('expired session returns 401', async () => {
      const fixedTime = 1000000;
      const srv = await createTestServer({
        records: [],
        authOptions: {
          sessionDurationMs: 1000,
          clock: () => fixedTime,
        },
      });
      // Override auth clock to keep fixed time
      srv.auth._now = () => fixedTime;
      try {
        const { baseUrl } = srv;
        const login = await fetchJson(`${baseUrl}/api/auth/login`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ username: 'expiryuser', password: 'password123' }),
        });
        if (login.status === 401) {
          // User doesn't exist, register first
          await fetchJson(`${baseUrl}/api/auth/register`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ username: 'expiryuser', password: 'password123' }),
          });
        }
        const login2 = await fetchJson(`${baseUrl}/api/auth/login`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ username: 'expiryuser', password: 'password123' }),
        });
        assert.equal(login2.status, 200);
        const sid = extractSid(login2.headers);

        srv.auth._now = () => fixedTime + 2000;

        const watchRes = await fetchJson(`${baseUrl}/api/watch-list`, {
          headers: { cookie: `sid=${sid}` },
        });
        assert.equal(watchRes.status, 401);
      } finally {
        await srv.close();
      }
    });
  });
});
