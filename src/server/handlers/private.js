import { StatusError } from '../server.js';
import { createHash } from 'node:crypto';

const VALID_TARGET_KINDS = new Set(['product', 'category', 'saved_search']);
const SUGGESTIONS_RE = /^[a-zA-Z][a-zA-Z0-9_-]{2,29}$/;

const RATE_LIMIT_REGISTER = { max: 5, windowMs: 60000 };
const RATE_LIMIT_LOGIN = { max: 20, windowMs: 60000 };

function validateUsername(u) {
  return SUGGESTIONS_RE.test(u);
}

function rateLimitCheck(ctx, appDb, policy, bucketType) {
  const ip = ctx.req?.socket?.remoteAddress || 'unknown';
  const bucketKey = `${bucketType}:${ip}`;
  const now = ctx.clock();
  const allowed = appDb.checkAndIncrementRateLimit(bucketKey, policy.max, policy.windowMs, now);
  if (!allowed) {
    const retryAfter = Math.ceil(policy.windowMs / 1000);
    throw Object.assign(
      new StatusError(429, 'RATE_LIMITED', 'Too many requests. Please try again later.'),
      { retryAfter }
    );
  }
}

export function createPrivateHandlers({ auth, appDb, clock }) {
  async function register(ctx) {
    const { username, password } = ctx.body || {};
    if (!username || !password) {
      throw new StatusError(400, 'VALIDATION_ERROR', 'Username and password are required');
    }
    rateLimitCheck(ctx, appDb, RATE_LIMIT_REGISTER, 'register');
    if (!validateUsername(String(username))) {
      throw new StatusError(400, 'VALIDATION_ERROR', 'Username must be 3-30 characters, start with a letter, and contain only letters, numbers, underscores, or hyphens');
    }
    if (typeof password !== 'string' || password.length < 8 || password.length > 256) {
      throw new StatusError(400, 'VALIDATION_ERROR', 'Password must be between 8 and 256 characters');
    }
    try {
      const user = await auth.register(username, password);
      return { user: { id: user.id, username: user.username } };
    } catch (err) {
      if (err.name === 'AuthError') {
        throw new StatusError(409, 'USERNAME_TAKEN', err.message);
      }
      throw err;
    }
  }

  async function login(ctx) {
    const { username, password } = ctx.body || {};
    if (!username || !password) {
      throw new StatusError(400, 'VALIDATION_ERROR', 'Username and password are required');
    }
    rateLimitCheck(ctx, appDb, RATE_LIMIT_LOGIN, 'login');
    try {
      const result = await auth.login(username, password);
      const maxAge = auth.sessionDurationMs / 1000;
      const cookieParts = [
        `sid=${result.token}`,
        'HttpOnly',
        'SameSite=Strict',
        'Path=/',
        `Max-Age=${maxAge}`,
      ];
      const trustSecureHeader = process.env.TRUST_PROXY_HEADERS === '1';
      if ((trustSecureHeader && ctx.headers?.['x-forwarded-proto'] === 'https') || ctx.req?.socket?.encrypted) {
        cookieParts.push('Secure');
      }
      ctx.setCookie('sid', cookieParts.join('; '));
      return { user: { id: result.user.id, username: result.user.username } };
    } catch (err) {
      if (err.name === 'AuthError') {
        throw new StatusError(401, 'INVALID_CREDENTIALS', 'Invalid credentials');
      }
      throw err;
    }
  }

  async function logout(ctx) {
    const sid = ctx.cookies?.sid;
    if (sid) {
      auth.logout(sid);
    }
    ctx.setCookie('sid', 'sid=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
    return {};
  }

  async function me(ctx) {
    const user = await requireUser(ctx);
    return { user: { id: user.id, username: user.username } };
  }

  async function requireUser(ctx) {
    const sid = ctx.cookies?.sid;
    if (!sid) {
      throw new StatusError(401, 'UNAUTHORIZED', 'Authentication required');
    }
    const user = auth.getSessionUser(sid);
    if (!user) {
      throw new StatusError(401, 'UNAUTHORIZED', 'Authentication required');
    }
    return user;
  }

  async function getWatchList(ctx) {
    const user = await requireUser(ctx);
    const entries = appDb.getWatchList(user.id);
    return entries;
  }

  async function addWatchList(ctx) {
    const user = await requireUser(ctx);
    const { targetKind, targetId, label } = ctx.body || {};
    if (!targetKind || !VALID_TARGET_KINDS.has(targetKind)) {
      throw new StatusError(400, 'VALIDATION_ERROR', 'targetKind must be product, category, or saved_search');
    }
    if (!targetId || typeof targetId !== 'string' || targetId.length === 0) {
      throw new StatusError(400, 'VALIDATION_ERROR', 'targetId is required');
    }
    if (!label || typeof label !== 'string' || label.length === 0) {
      throw new StatusError(400, 'VALIDATION_ERROR', 'label is required');
    }
    if (targetKind !== 'saved_search' && !/^[a-z]+:[a-zA-Z0-9_-]+$/.test(targetId)) {
      throw new StatusError(400, 'VALIDATION_ERROR', 'Invalid targetId format');
    }
    if (label.length > 200) {
      throw new StatusError(400, 'VALIDATION_ERROR', 'label must be 200 characters or fewer');
    }
    const entryId = appDb.addWatchListEntry(user.id, targetKind, targetId, label);
    return { id: entryId };
  }

  async function deleteWatchList(ctx) {
    const user = await requireUser(ctx);
    const entryId = Number(ctx.params.entryId);
    if (!Number.isFinite(entryId) || entryId < 1) {
      throw new StatusError(400, 'VALIDATION_ERROR', 'Invalid entry ID');
    }
    const entry = appDb.getWatchListEntry(entryId);
    if (!entry || entry.user_id !== user.id) {
      throw new StatusError(404, 'NOT_FOUND', 'Watch list entry not found');
    }
    appDb.deleteWatchListEntry(entryId);
    return {};
  }

  async function getPreferredStores(ctx) {
    const user = await requireUser(ctx);
    const prefs = appDb.getStorePreferences(user.id);
    return prefs.map(p => ({
      id: p.id,
      contextId: p.context_id,
      rank: p.rank,
      userId: p.user_id,
    }));
  }

  async function setPreferredStore(ctx) {
    const user = await requireUser(ctx);
    const { contextId, rank } = ctx.body || {};
    if (contextId == null || typeof contextId !== 'number') {
      throw new StatusError(400, 'VALIDATION_ERROR', 'contextId is required and must be a number');
    }
    if (rank == null || typeof rank !== 'number' || rank < 0) {
      throw new StatusError(400, 'VALIDATION_ERROR', 'rank is required and must be >= 0');
    }
    if (!Number.isFinite(contextId) || contextId < 1) {
      throw new StatusError(400, 'VALIDATION_ERROR', 'Invalid contextId');
    }
    if (rank === 0) {
      appDb.deleteStorePreference(user.id, contextId);
      return {};
    }
    appDb.setStorePreference(user.id, contextId, rank);
    return {};
  }

  async function deletePreferredStore(ctx) {
    const user = await requireUser(ctx);
    const contextId = Number(ctx.params.contextId);
    if (!Number.isFinite(contextId) || contextId < 1) {
      throw new StatusError(400, 'VALIDATION_ERROR', 'Invalid context ID');
    }
    appDb.deleteStorePreference(user.id, contextId);
    return {};
  }

  async function getSavedSearches(ctx) {
    const user = await requireUser(ctx);
    const searches = appDb.getSavedSearches(user.id);
    return searches.map(s => ({
      id: s.id,
      name: s.name,
      queryText: s.query_text,
      retailerFilter: s.retailer_filter || null,
      categoryFilter: s.category_filter || null,
      createdAt: s.created_at,
    }));
  }

  async function createSavedSearch(ctx) {
    const user = await requireUser(ctx);
    const { name, queryText, retailerFilter, categoryFilter } = ctx.body || {};
    if (!name || typeof name !== 'string' || name.trim().length === 0) {
      throw new StatusError(400, 'VALIDATION_ERROR', 'name is required');
    }
    if (!queryText || typeof queryText !== 'string' || queryText.trim().length === 0) {
      throw new StatusError(400, 'VALIDATION_ERROR', 'queryText is required');
    }
    if (name.length > 100) {
      throw new StatusError(400, 'VALIDATION_ERROR', 'name must be 100 characters or fewer');
    }
    if (queryText.length > 200) {
      throw new StatusError(400, 'VALIDATION_ERROR', 'queryText must be 200 characters or fewer');
    }
    const normalized = queryText.trim().toLowerCase().replace(/\s+/g, ' ');
    const normalizedHash = createHash('sha256').update(normalized).digest('hex');
    const search = appDb.createSavedSearch(
      user.id, name.trim(), queryText.trim(),
      retailerFilter || null, categoryFilter || null, normalizedHash
    );
    if (!search) {
      throw new StatusError(409, 'DUPLICATE_SEARCH', 'A saved search with this query already exists');
    }
    return {
      id: search.id,
      name: search.name,
      queryText: search.query_text,
      retailerFilter: search.retailer_filter || null,
      categoryFilter: search.category_filter || null,
      createdAt: search.created_at,
    };
  }

  async function deleteSavedSearch(ctx) {
    const user = await requireUser(ctx);
    const searchId = Number(ctx.params.searchId);
    if (!Number.isFinite(searchId) || searchId < 1) {
      throw new StatusError(400, 'VALIDATION_ERROR', 'Invalid search ID');
    }
    const search = appDb.getSavedSearch(searchId);
    if (!search || search.user_id !== user.id) {
      throw new StatusError(404, 'NOT_FOUND', 'Saved search not found');
    }
    appDb.deleteSavedSearch(searchId);
    return {};
  }

  async function getNewProducts(ctx) {
    const user = await requireUser(ctx);
    const notices = appDb.getNewProductNotices();
    const products = notices.map(n => ({
      id: n.id,
      productId: n.product_id,
      retailerId: n.retailer_id,
      firstSeenAt: n.first_seen_at,
    }));
    const lastCheckedAt = new Date(clock()).toISOString();
    appDb.markAllNotified();
    return { products, lastCheckedAt };
  }

  return {
    register,
    login,
    logout,
    me,
    getWatchList,
    addWatchList,
    deleteWatchList,
    getPreferredStores,
    setPreferredStore,
    deletePreferredStore,
    getSavedSearches,
    createSavedSearch,
    deleteSavedSearch,
    getNewProducts,
  };
}
