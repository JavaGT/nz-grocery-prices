import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { gzipSync, brotliCompressSync, constants as zlibConstants } from 'node:zlib';

const MAX_BODY = 65536;
const MAX_COOKIE_LENGTH = 4096;
const MAX_COOKIE_COUNT = 20;
// JSON responses below this size go out uncompressed: the CPU cost of gzipping
// outweighs the wire savings once headers are counted.
const MIN_COMPRESS_BYTES = 1024;

// Dynamic API bodies are brotli-compressed at an explicit quality (measured on
// real payloads: q5 is smaller AND faster than gzip level 6 at ~60KB, ~1.2x
// gzip CPU at ~14KB, for 5-11% fewer bytes). Quality 11, the static-file
// default, costs ~20ms on the same body — far too slow per request.
const BROTLI_DYNAMIC = { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 5 } };

// Bound on the Server-side encoded-response cache (see CachedResponse): when
// full, the whole map drops (same policy as the deals universe cache). Entries
// hold serialized strings + one compressed tail each, so 32 keeps worst-case
// memory at a few MB.
const MAX_CACHED_BODIES = 32;

// `{"_requestId":"<36-char uuid>"` — the per-request head of every cached
// response body.
const REQUEST_ID_PREFIX_TEMPLATE = '{"_requestId":"' + '0'.repeat(36) + '"';

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

// Marks a handler result as byte-stable for a window of time so the transport
// layer can reuse the serialized JSON and compressed bytes across requests
// instead of re-running JSON.stringify + compression per response. Handlers
// stay encoding-agnostic: they declare payload identity, the Server owns how
// that becomes bytes.
//
// - token: identity of the payload content. It MUST change whenever the body
//   would change (e.g. include the projection dbSignature and the computation
//   generation) and MUST be unique per payload variant (per query shape, per
//   user tiering, ...): the Server trusts it and serves the cached bytes.
// - maxAgeMs: how long the encoded bytes may be reused; the freshness snapshot
//   embedded in the response is frozen for the same window, which is safe
//   because the projection only changes when the token changes (dbSignature).
// - body: the plain response object. Keys `_requestId` / `_freshness` /
//   `retryAfter` are reserved for the transport; bodies containing them (or
//   non-plain-object bodies) fall back to the uncached path, which serializes
//   exactly as before.
export class CachedResponse {
  constructor({ token, body, maxAgeMs = 0 }) {
    this.token = String(token);
    this.body = body;
    this.maxAgeMs = Number(maxAgeMs);
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
  // token -> { createdAt, tail, gzipTail, plainSize } for CachedResponse
  // bodies (see #respondCached).
  #bodyCache = new Map();

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

    // The projection metadata (`_meta` read) is identical for every response
    // this request produces, so it is computed at most once per request and
    // only when something actually needs it (JSON handlers and payloads do;
    // static-file fallbacks never touch it).
    let freshnessMemo;
    const freshness = () => freshnessMemo ?? (freshnessMemo = this.#projMeta());

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
        }, requestId, null, req.headers['accept-encoding'], freshness);
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
        }, requestId, null, req.headers['accept-encoding'], freshness);
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
        freshness: freshness(),
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
        this.#respond(res, 200, result, requestId, cookieHeaderSet, req.headers['accept-encoding'], freshness);
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
        this.#respond(res, err.status, errBody, requestId, null, req.headers['accept-encoding'], freshness);
      } else {
        this.#log.error('Unhandled error:', err);
        this.#respond(res, 500, {
          error: { code: 'INTERNAL_ERROR', message: 'Internal server error' }
        }, requestId, null, req.headers['accept-encoding'], freshness);
      }
    }

    const elapsed = this.#clock() - startTime;
    this.#log.info(`${req.method} ${req.url} ${res.statusCode} ${elapsed}ms`);
  }

  // `freshness` is the per-request memoized #projMeta thunk from #handle so a
  // request that touches projection metadata pays for the `_meta` read once,
  // no matter how many payload snapshots it needs.
  #respond(res, status, body, requestId, cookieHeader, acceptEncoding, freshness) {
    if (body instanceof CachedResponse) {
      return this.#respondCached(res, status, body, requestId, cookieHeader, acceptEncoding, freshness);
    }
    return this.#respondPlain(res, status, body, requestId, cookieHeader, acceptEncoding, freshness);
  }

  #respondPlain(res, status, body, requestId, cookieHeader, acceptEncoding, freshness) {
    const payload = { _requestId: requestId };
    const meta = freshness ? freshness() : this.#projMeta();
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
    if (out.length >= MIN_COMPRESS_BYTES && (accepted.br > 0 || accepted.gzip > 0)) {
      try {
        if (accepted.br > 0) {
          out = brotliCompressSync(out, BROTLI_DYNAMIC);
          headers['content-encoding'] = 'br';
        } else {
          out = gzipSync(out);
          headers['content-encoding'] = 'gzip';
        }
      } catch (err) {
        this.#log.error('[server] compression failed:', err.message);
      }
    }

    headers['content-length'] = out.length;
    res.writeHead(status, headers);
    res.end(out);
  }

  // Serves a CachedResponse by reusing the encoded bytes stored for its token:
  // the response splits into a tiny per-request prefix (fresh `_requestId`) and
  // a cached tail (frozen `_freshness` + payload, serialized once). The
  // decompressed JSON is byte-identical to the plain path on every request.
  //
  // Encoded reuse per client encoding:
  // - identity: string concat of prefix + tail (no compression at all);
  // - gzip: multi-member stream — RFC 1952 members decode as one body, so a
  //   freshly gzipped prefix concatenates with the cached gzipped tail;
  // - br: brotli frames must NOT be concatenated (decoders disagree on
  //   trailing frames), so br requests get a full q5 recompress of the
  //   reused tail string — still skipping stringify and the _meta query.
  #respondCached(res, status, cached, requestId, cookieHeader, acceptEncoding, freshness) {
    const b = cached.body;
    const cacheable = b && b.constructor === Object && !Array.isArray(b) &&
      !('_requestId' in b) && !('_freshness' in b) && !('retryAfter' in b) &&
      Number.isFinite(cached.maxAgeMs) && cached.maxAgeMs > 0;
    if (!cacheable) {
      return this.#respondPlain(res, status, b, requestId, cookieHeader, acceptEncoding, freshness);
    }

    const headers = {
      'content-type': 'application/json',
      'x-content-type-options': 'nosniff',
      'x-request-id': requestId,
      'x-frame-options': 'SAMEORIGIN',
      'referrer-policy': 'no-referrer',
      vary: 'Accept-Encoding',
    };
    if (cookieHeader) headers['set-cookie'] = cookieHeader;

    const now = this.#clock();
    let entry = this.#bodyCache.get(cached.token);
    if (entry && now - entry.createdAt > cached.maxAgeMs) {
      this.#bodyCache.delete(cached.token);
      entry = undefined;
    }
    if (!entry) {
      const meta = freshness ? freshness() : this.#projMeta();
      const freshnessJson = JSON.stringify({
        exists: meta.exists,
        fingerprint: meta.fingerprint,
        builtAt: meta.builtAt,
        recordsImported: meta.recordsImported,
      });
      const bodyJson = JSON.stringify(b);
      // Everything after the per-request `_requestId` value, including the
      // closing brace: `,"_freshness":...,"payload":...}`.
      const tail = ',"_freshness":' + freshnessJson + ',' + bodyJson.slice(1);
      entry = {
        createdAt: now,
        // Uncompressed size the plain path would have produced; drives the
        // MIN_COMPRESS_BYTES decision. UUID v4 request IDs are always 36 chars.
        plainSize: REQUEST_ID_PREFIX_TEMPLATE.length + tail.length,
        tail,
        gzipTail: undefined,
      };
      if (this.#bodyCache.size >= MAX_CACHED_BODIES) this.#bodyCache.clear();
      this.#bodyCache.set(cached.token, entry);
    }

    const prefix = REQUEST_ID_PREFIX_TEMPLATE.slice(0, -37) + requestId + '"';
    let out;
    let encoding;
    const accepted = parseAcceptEncoding(acceptEncoding);
    if (entry.plainSize >= MIN_COMPRESS_BYTES && (accepted.br > 0 || accepted.gzip > 0)) {
      try {
        if (accepted.br > 0) {
          out = brotliCompressSync(Buffer.from(prefix + entry.tail), BROTLI_DYNAMIC);
          encoding = 'br';
        } else {
          if (!entry.gzipTail) entry.gzipTail = gzipSync(Buffer.from(entry.tail));
          out = Buffer.concat([gzipSync(Buffer.from(prefix)), entry.gzipTail]);
          encoding = 'gzip';
        }
      } catch (err) {
        this.#log.error('[server] compression failed:', err.message);
      }
    }
    if (!out) {
      out = Buffer.from(prefix + entry.tail);
      encoding = undefined;
    }
    if (encoding) headers['content-encoding'] = encoding;

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
