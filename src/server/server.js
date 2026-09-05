import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { gzipSync } from 'node:zlib';

const MAX_BODY = 65536;
const MAX_COOKIE_LENGTH = 4096;
const MAX_COOKIE_COUNT = 20;
// JSON responses below this size go out uncompressed: the CPU cost of gzipping
// outweighs the wire savings once headers are counted.
const MIN_COMPRESS_BYTES = 1024;

// Parses an Accept-Encoding header into { encoding: q } for the encodings this
// server can produce (q=0 means "not accepted"). Single source of truth shared
// with static serving in src/app/server.js.
export function parseAcceptEncoding(header) {
  const out = { gzip: 0, br: 0 };
  if (!header) return out;
  for (const part of String(header).split(',')) {
    const pieces = part.trim().split(';');
    const token = pieces[0].trim().toLowerCase();
    if (!(token in out)) continue;
    let q = 1;
    for (const param of pieces.slice(1)) {
      const p = param.trim();
      if (p.startsWith('q=')) {
        q = Number.parseFloat(p.slice(2));
        if (!Number.isFinite(q)) q = 0;
      }
    }
    out[token] = q;
  }
  return out;
}

export class StatusError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'StatusError';
    this.status = status;
    this.code = code;
  }
}

export class Server {
  #server = null;
  #projDb = null;
  #appDb = null;
  #auth = null;
  #log;
  #clock;
  #startedAt = 0;
  #routes = [];
  #fallback = null;

  constructor({ projDb, appDb, auth, logger = console, clock = Date.now } = {}) {
    this.#projDb = projDb;
    this.#appDb = appDb;
    this.#auth = auth;
    this.#log = logger;
    this.#clock = clock;
  }

  get(path, handler) { return this.#route('GET', path, handler); }
  post(path, handler) { return this.#route('POST', path, handler); }
  put(path, handler) { return this.#route('PUT', path, handler); }
  delete(path, handler) { return this.#route('DELETE', path, handler); }
  patch(path, handler) { return this.#route('PATCH', path, handler); }

  setFallback(handler) {
    this.#fallback = handler;
    return this;
  }

  #route(method, path, handler) {
    const names = [];
    const re = new RegExp(
      '^' + path.replace(/:([a-zA-Z_]+)/g, (_, n) => { names.push(n); return '([^/]+)'; }) + '$'
    );
    this.#routes.push({ method, re, names, handler });
    return this;
  }

  start(port = 0) {
    return new Promise(resolve => {
      this.#startedAt = this.#clock();
      this.#server = createServer((req, res) => this.#handle(req, res));
      this.#server.listen(port, () => resolve(this.#server.address().port));
    });
  }

  stop() {
    return new Promise(resolve => {
      if (!this.#server) return resolve();
      this.#server.close(() => resolve());
    });
  }

  get port() {
    return this.#server?.address()?.port;
  }

  get startedAt() {
    return this.#startedAt;
  }

  #projMeta() {
    if (!this.#projDb) return { exists: false };
    try {
      const rows = this.#projDb.prepare('SELECT key, value FROM _meta').all();
      const m = Object.fromEntries(rows.map(r => [r.key, r.value]));
      return {
        exists: true,
        fingerprint: m.jsonl_fingerprint || null,
        builtAt: m.built_at || null,
        recordsImported: Number(m.records_imported) || 0,
        errorCount: Number(m.error_count) || 0,
      };
    } catch {
      return { exists: false };
    }
  }

  #parseCookies(req) {
    const header = req.headers.cookie;
    if (!header) return {};
    if (header.length > MAX_COOKIE_LENGTH) return {};
    const cookies = {};
    let count = 0;
    for (const pair of header.split(';')) {
      const trimmed = pair.trim();
      if (!trimmed) continue;
      count++;
      if (count > MAX_COOKIE_COUNT) return {};
      const sep = trimmed.indexOf('=');
      if (sep <= 0) continue;
      const name = trimmed.slice(0, sep).trim();
      const value = trimmed.slice(sep + 1).trim();
      if (name && value) {
        cookies[name] = decodeURIComponent(value);
      }
    }
    return cookies;
  }

  #checkCSRF(req) {
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') {
      return;
    }
    const origin = req.headers.origin;
    if (!origin) return;
    if (!this.#server) return;
    try {
      const address = this.#server.address();
      if (!address || typeof address === 'string') return;
      const originUrl = new URL(origin);
      const expectedPort = String(address.port);
      if (originUrl.hostname !== '127.0.0.1' && originUrl.hostname !== 'localhost' &&
          originUrl.hostname !== address.address) {
        throw new StatusError(403, 'CSRF_REJECTED', 'Cross-origin request rejected');
      }
      const originPort = originUrl.port || (req.socket?.encrypted ? '443' : '80');
      if (originPort !== expectedPort) {
        throw new StatusError(403, 'CSRF_REJECTED', 'Cross-origin request rejected');
      }
    } catch (err) {
      if (err instanceof StatusError) throw err;
    }
  }

  async #handle(req, res) {
    const requestId = randomUUID();
    const startTime = this.#clock();

    try {
      this.#checkCSRF(req);

      const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      const pathname = url.pathname.replace(/\/+$/, '') || '/';
      const queryObj = Object.fromEntries(url.searchParams);

      const allowed = new Set(
        this.#routes.filter(r => r.re.test(pathname)).map(r => r.method)
      );
      if (allowed.size > 0 && !allowed.has(req.method)) {
        return this.#respond(res, 405, {
          error: { code: 'METHOD_NOT_ALLOWED', message: `${req.method} not allowed for ${pathname}` }
        }, requestId, null, req.headers['accept-encoding']);
      }

      let matched = null;
      for (const route of this.#routes) {
        if (route.method !== req.method) continue;
        const m = route.re.exec(pathname);
        if (m) {
          const params = {};
          route.names.forEach((name, i) => { params[name] = decodeURIComponent(m[i + 1]); });
          matched = { handler: route.handler, params };
          break;
        }
      }

      if (!matched) {
        if (this.#fallback) {
          return this.#fallback(req, res, pathname, requestId);
        }
        return this.#respond(res, 404, {
          error: { code: 'NOT_FOUND', message: `${pathname} not found` }
        }, requestId, null, req.headers['accept-encoding']);
      }

      let body = null;
      if (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH') {
        body = await this.#parseBody(req);
      }

      const cookies = this.#parseCookies(req);

      let cookieHeaderSet = null;
      const ctx = {
        params: matched.params,
        query: queryObj,
        body,
        requestId,
        projection: this.#projDb,
        appDb: this.#appDb,
        auth: this.#auth,
        clock: this.#clock,
        freshness: this.#projMeta(),
        cookies,
        headers: req.headers,
        req,
        setCookie(name, value) {
          cookieHeaderSet = value;
        },
      };

      if (cookies.sid && !/^[a-f0-9]{64}$/i.test(cookies.sid)) {
        delete cookies.sid;
      }

      const result = await matched.handler(ctx);
      if (result !== undefined) {
        this.#respond(res, 200, result, requestId, cookieHeaderSet, req.headers['accept-encoding']);
      } else if (cookieHeaderSet) {
        this.#finalizeResponse(res, 200, requestId, cookieHeaderSet);
      }
    } catch (err) {
      if (err instanceof StatusError) {
        const errBody = {
          error: { code: err.code, message: err.message }
        };
        if (err.retryAfter) {
          errBody.retryAfter = err.retryAfter;
        }
        this.#respond(res, err.status, errBody, requestId, null, req.headers['accept-encoding']);
      } else {
        this.#log.error('Unhandled error:', err);
        this.#respond(res, 500, {
          error: { code: 'INTERNAL_ERROR', message: 'Internal server error' }
        }, requestId, null, req.headers['accept-encoding']);
      }
    }

    const elapsed = this.#clock() - startTime;
    this.#log.info(`${req.method} ${req.url} ${res.statusCode} ${elapsed}ms`);
  }

  #respond(res, status, body, requestId, cookieHeader, acceptEncoding) {
    const payload = { _requestId: requestId };
    const meta = this.#projMeta();
    payload._freshness = {
      exists: meta.exists,
      fingerprint: meta.fingerprint,
      builtAt: meta.builtAt,
      recordsImported: meta.recordsImported,
    };

    const headers = {
      'content-type': 'application/json',
      'x-content-type-options': 'nosniff',
      'x-request-id': requestId,
      'x-frame-options': 'SAMEORIGIN',
      'referrer-policy': 'no-referrer',
      // Responses are compressible, so caches must key on encoding choice.
      vary: 'Accept-Encoding',
    };
    if (cookieHeader) headers['set-cookie'] = cookieHeader;

    if (body && typeof body === 'object' && body.constructor === Object && body.retryAfter) {
      headers['retry-after'] = String(body.retryAfter);
      delete body.retryAfter;
    }

    let json;
    if (Array.isArray(body)) {
      json = JSON.stringify(body);
    } else {
      if (body && typeof body === 'object') {
        Object.assign(payload, body);
      }
      json = JSON.stringify(payload);
    }

    let out = Buffer.from(json);
    const accepted = parseAcceptEncoding(acceptEncoding);
    if (accepted.gzip > 0 && out.length >= MIN_COMPRESS_BYTES) {
      try {
        out = gzipSync(out);
        headers['content-encoding'] = 'gzip';
      } catch (err) {
        this.#log.error('[server] gzip compression failed:', err.message);
      }
    }

    headers['content-length'] = out.length;
    res.writeHead(status, headers);
    res.end(out);
  }

  #finalizeResponse(res, status, requestId, cookieHeader) {
    const headers = {
      'content-type': 'application/json',
      'x-request-id': requestId,
    };
    if (cookieHeader) headers['set-cookie'] = cookieHeader;
    res.writeHead(status, headers);
    res.end(JSON.stringify({ _requestId }));
  }

  #parseBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      req.on('data', chunk => {
        size += chunk.length;
        if (size > MAX_BODY) {
          reject(new StatusError(413, 'PAYLOAD_TOO_LARGE', 'Request body exceeds 64KB limit'));
          req.resume();
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => {
        if (chunks.length === 0) return resolve(null);
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch {
          reject(new StatusError(400, 'INVALID_JSON', 'Request body must be valid JSON'));
        }
      });
      req.on('error', reject);
    });
  }
}
