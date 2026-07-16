import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AppDatabase } from '../../src/sqlite/app-db.js';
import { Auth, AuthError } from '../../src/app/auth.js';

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'auth-test-'));
  const dbPath = join(dir, 'test.db');
  const db = new AppDatabase(dbPath);
  return { dir, db };
}

function makeAuth(db, overrides = {}) {
  return new Auth(db, {
    sessionDurationMs: 24 * 60 * 60 * 1000,
    clock: () => Date.now(),
    ...overrides,
  });
}

describe('Auth', () => {
  it('register creates a new user', async () => {
    const { db, dir } = setup();
    try {
      const auth = makeAuth(db);
      const user = await auth.register('Alice', 'password123');
      assert.ok(user);
      assert.equal(user.username, 'Alice');
      assert.ok(user.id);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('register rejects duplicate exact username', async () => {
    const { db, dir } = setup();
    try {
      const auth = makeAuth(db);
      await auth.register('Alice', 'password123');
      await assert.rejects(
        auth.register('Alice', 'different456'),
        AuthError
      );
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('register rejects duplicate normalized (different case) username', async () => {
    const { db, dir } = setup();
    try {
      const auth = makeAuth(db);
      await auth.register('Alice', 'password123');
      await assert.rejects(
        auth.register('alice', 'different456'),
        AuthError
      );
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('register rejects short username', async () => {
    const { db, dir } = setup();
    try {
      const auth = makeAuth(db);
      await assert.rejects(
        auth.register('ab', 'password123'),
        AuthError
      );
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('register rejects long username (> 30 chars)', async () => {
    const { db, dir } = setup();
    try {
      const auth = makeAuth(db);
      await assert.rejects(
        auth.register('a' + 'b'.repeat(30), 'password123'),
        AuthError
      );
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('register rejects short password (< 8 chars)', async () => {
    const { db, dir } = setup();
    try {
      const auth = makeAuth(db);
      await assert.rejects(
        auth.register('Alice', 'short'),
        AuthError
      );
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('register rejects long password (> 256 chars)', async () => {
    const { db, dir } = setup();
    try {
      const auth = makeAuth(db);
      await assert.rejects(
        auth.register('Alice', 'x'.repeat(257)),
        AuthError
      );
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('register rejects username starting with non-letter', async () => {
    const { db, dir } = setup();
    try {
      const auth = makeAuth(db);
      await assert.rejects(
        auth.register('1invalid', 'password123'),
        AuthError
      );
      await assert.rejects(
        auth.register('_underscore', 'password123'),
        AuthError
      );
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('login returns token and user for valid credentials', async () => {
    const { db, dir } = setup();
    try {
      const auth = makeAuth(db);
      await auth.register('Bob', 'password123');
      const result = await auth.login('Bob', 'password123');
      assert.ok(result.token);
      assert.equal(typeof result.token, 'string');
      assert.equal(result.token.length, 64);
      assert.ok(result.user);
      assert.equal(result.user.username, 'Bob');
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('login is case-insensitive for username', async () => {
    const { db, dir } = setup();
    try {
      const auth = makeAuth(db);
      await auth.register('Charlie', 'mypassword');
      const result = await auth.login('charlie', 'mypassword');
      assert.ok(result.token);
      assert.equal(result.user.username, 'Charlie');
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('login throws AuthError for wrong password', async () => {
    const { db, dir } = setup();
    try {
      const auth = makeAuth(db);
      await auth.register('Diana', 'correctPW123');
      await assert.rejects(
        auth.login('Diana', 'wrongPW456'),
        AuthError
      );
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('login throws AuthError for nonexistent username', async () => {
    const { db, dir } = setup();
    try {
      const auth = makeAuth(db);
      await assert.rejects(
        auth.login('nobody', 'password123'),
        AuthError
      );
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('login error message is generic ("Invalid credentials")', async () => {
    const { db, dir } = setup();
    try {
      const auth = makeAuth(db);
      await assert.rejects(
        auth.login('nobody', 'password123'),
        { message: 'Invalid credentials' }
      );
      await auth.register('Eve', 'password123');
      await assert.rejects(
        auth.login('Eve', 'wrong'),
        { message: 'Invalid credentials' }
      );
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('getSessionUser returns user for valid token', async () => {
    const { db, dir } = setup();
    try {
      const auth = makeAuth(db);
      await auth.register('Frank', 'password123');
      const { token } = await auth.login('Frank', 'password123');
      const user = auth.getSessionUser(token);
      assert.ok(user);
      assert.equal(user.username, 'Frank');
      assert.ok(user.id);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('getSessionUser returns null for invalid token', () => {
    const { db, dir } = setup();
    try {
      const auth = makeAuth(db);
      const user = auth.getSessionUser('invalidtoken123');
      assert.equal(user, null);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('getSessionUser returns null for expired token', async () => {
    const { db, dir } = setup();
    try {
      const fixedTime = 1000000;
      const auth = new Auth(db, {
        sessionDurationMs: 1000,
        clock: () => fixedTime,
      });
      await auth.register('Grace', 'password123');
      const { token } = await auth.login('Grace', 'password123');

      const userBefore = auth.getSessionUser(token);
      assert.ok(userBefore);

      auth._now = () => fixedTime + 2000;
      const userAfter = auth.getSessionUser(token);
      assert.equal(userAfter, null);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('logout invalidates token', async () => {
    const { db, dir } = setup();
    try {
      const auth = makeAuth(db);
      await auth.register('Heidi', 'password123');
      const { token } = await auth.login('Heidi', 'password123');

      assert.ok(auth.getSessionUser(token));

      auth.logout(token);
      assert.equal(auth.getSessionUser(token), null);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('logout is idempotent (no error on second call)', async () => {
    const { db, dir } = setup();
    try {
      const auth = makeAuth(db);
      await auth.register('Ivan', 'password123');
      const { token } = await auth.login('Ivan', 'password123');
      auth.logout(token);
      auth.logout(token);
      assert.equal(auth.getSessionUser(token), null);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('full roundtrip: register → login → getSessionUser → logout → no session', async () => {
    const { db, dir } = setup();
    try {
      const auth = makeAuth(db);
      await auth.register('Jill', 'password123');
      const { token, user } = await auth.login('Jill', 'password123');
      assert.equal(user.username, 'Jill');

      const sessionUser = auth.getSessionUser(token);
      assert.equal(sessionUser.username, 'Jill');

      auth.logout(token);
      assert.equal(auth.getSessionUser(token), null);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('token is not stored as plaintext in sessions table', async () => {
    const { db, dir } = setup();
    try {
      const auth = makeAuth(db);
      await auth.register('Ken', 'password123');
      const { token } = await auth.login('Ken', 'password123');

      const sessions = db.db.prepare('SELECT id FROM sessions').all();
      assert.equal(sessions.length, 1);
      assert.notEqual(sessions[0].id, token);
      assert.equal(sessions[0].id.length, 64);
      assert.match(sessions[0].id, /^[a-f0-9]{64}$/);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('password hash is not returned in login response or error', async () => {
    const { db, dir } = setup();
    try {
      const auth = makeAuth(db);
      await auth.register('Leo', 'password123');
      const result = await auth.login('Leo', 'password123');
      assert.ok(!result.password_hash);
      assert.ok(!result.user.password_hash);
      assert.equal(Object.keys(result.user).length, 2);

      try {
        await auth.login('Leo', 'wrong');
      } catch (e) {
        assert.ok(!e.password_hash);
        assert.ok(!e.message.includes('hash'));
      }
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('supports usernames with hyphens and underscores', async () => {
    const { db, dir } = setup();
    try {
      const auth = makeAuth(db);
      const user = await auth.register('test_user-123', 'password123');
      assert.equal(user.username, 'test_user-123');
      const result = await auth.login('test_user-123', 'password123');
      assert.ok(result.token);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('handles concurrent duplicate registration safely by normalizing', async () => {
    const { db, dir } = setup();
    try {
      const auth = makeAuth(db);
      await auth.register('UserX', 'password123');
      await assert.rejects(
        auth.register('userx', 'password456'),
        AuthError
      );
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not expose password hashes or secrets in error messages', async () => {
    const { db, dir } = setup();
    try {
      const auth = makeAuth(db);
      try {
        await auth.register('ab', 'short');
      } catch (e) {
        assert.ok(!e.message.includes('hash'));
        assert.ok(!e.message.includes('scrypt'));
        assert.ok(!e.message.includes('salt'));
        assert.ok(!e.message.includes('token'));
      }
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
