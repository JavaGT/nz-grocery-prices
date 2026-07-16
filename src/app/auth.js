import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { createHash } from 'node:crypto';

const SALT_BYTES = 16;
const KEY_LEN = 64;
const SCRYPT_OPTS = { N: 16384, r: 8, p: 1 };
const TOKEN_BYTES = 32;
const DAY_MS = 24 * 60 * 60 * 1000;

const USERNAME_RE = /^[a-zA-Z][a-zA-Z0-9_-]{2,29}$/;

export class AuthError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AuthError';
  }
}

export class Auth {
  constructor(appDb, options = {}) {
    this.db = appDb;
    this.sessionDurationMs = options.sessionDurationMs ?? DAY_MS;
    this._now = options.clock ?? (() => Date.now());
  }

  async register(username, password) {
    const u = (username ?? '').trim();
    if (!USERNAME_RE.test(u)) {
      throw new AuthError(
        'Username must be 3-30 characters, start with a letter, and contain only letters, numbers, underscores, or hyphens'
      );
    }
    if (typeof password !== 'string' || password.length < 8 || password.length > 256) {
      throw new AuthError('Password must be between 8 and 256 characters');
    }

    const passwordHash = await this._hashPassword(password);

    let user;
    try {
      user = this.db.createUser(u, passwordHash);
    } catch (err) {
      if (err?.message?.includes?.('UNIQUE')) {
        throw new AuthError('Username already taken');
      }
      throw err;
    }

    if (!user) {
      throw new AuthError('Username already taken');
    }

    return { id: user.id, username: user.username };
  }

  async login(username, password) {
    const u = (username ?? '').trim().toLowerCase();
    if (!u || typeof password !== 'string' || !password) {
      throw new AuthError('Invalid credentials');
    }

    const user = this.db.getUserByUsername(u);
    if (!user) {
      throw new AuthError('Invalid credentials');
    }

    const valid = await this._verifyPassword(password, user.password_hash);
    if (!valid) {
      throw new AuthError('Invalid credentials');
    }

    const rawToken = this._generateToken();
    const tokenHash = this._hashToken(rawToken);
    const expiresAt = this._now() + this.sessionDurationMs;
    this.db.createSession(user.id, tokenHash, expiresAt);

    return {
      token: rawToken,
      user: { id: user.id, username: user.username },
    };
  }

  logout(sessionToken) {
    if (!sessionToken) return;
    const tokenHash = this._hashToken(sessionToken);
    this.db.deleteSession(tokenHash);
  }

  getSessionUser(sessionToken) {
    if (!sessionToken) return null;
    const tokenHash = this._hashToken(sessionToken);
    const session = this.db.getSession(tokenHash);
    if (!session) return null;
    if (session.expires_at <= this._now()) {
      this.db.deleteSession(tokenHash);
      return null;
    }
    return { id: session.user_id, username: session.username };
  }

  _hashToken(token) {
    return createHash('sha256').update(token).digest('hex');
  }

  _generateToken() {
    return randomBytes(TOKEN_BYTES).toString('hex');
  }

  _scrypt(password, salt, keylen) {
    return new Promise((resolve, reject) => {
      scrypt(password, salt, keylen, SCRYPT_OPTS, (err, key) => {
        if (err) reject(err);
        else resolve(key);
      });
    });
  }

  async _hashPassword(password) {
    const salt = randomBytes(SALT_BYTES);
    const key = await this._scrypt(password, salt, KEY_LEN);
    return `${salt.toString('hex')}:${key.toString('hex')}`;
  }

  async _verifyPassword(password, stored) {
    const sep = stored.indexOf(':');
    if (sep <= 0) return false;
    const saltHex = stored.slice(0, sep);
    const digestHex = stored.slice(sep + 1);
    const salt = Buffer.from(saltHex, 'hex');
    const expected = Buffer.from(digestHex, 'hex');
    if (salt.length === 0 || expected.length === 0) return false;
    try {
      const key = await this._scrypt(password, salt, expected.length);
      return timingSafeEqual(key, expected);
    } catch {
      return false;
    }
  }
}
