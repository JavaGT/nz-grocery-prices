#!/usr/bin/env node

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const CDP_HOST = process.env.CDP_HOST ?? "http://127.0.0.1:9222";
const OUTPUT = resolve(process.argv[2] ?? "research/paknsave-deals.har");
const WAIT_MS = Number(process.env.CAPTURE_WAIT_MS ?? 12_000);
const URL_MATCH = process.env.CAPTURE_URL_MATCH ?? "paknsave.co.nz/shop/deals";
const REDACTED = "[REDACTED]";
const sensitiveName = /(authorization|cookie|token|secret|password|api[-_]?key)/i;

function sanitizeValue(name, value) {
  return sensitiveName.test(name) ? REDACTED : String(value);
}

function sanitizeObject(value) {
  if (Array.isArray(value)) return value.map(sanitizeObject);
  if (!value || typeof value !== "object") return value;

  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [
      key,
      sensitiveName.test(key) ? REDACTED : sanitizeObject(child),
    ]),
  );
}

function sanitizePostData(postData) {
  if (!postData) return undefined;
  try {
    return JSON.stringify(sanitizeObject(JSON.parse(postData)));
  } catch {
    return postData.replace(
      /((?:authorization|token|secret|password|api[-_]?key)=)[^&]*/gi,
      `$1${REDACTED}`,
    );
  }
}

function sanitizeResponseBody(body, mimeType) {
  if (!body) return body;
  if (!mimeType?.includes("json")) return body;

  try {
    return JSON.stringify(sanitizeObject(JSON.parse(body)));
  } catch {
    return body;
  }
}

function headersToHar(headers = {}) {
  return Object.entries(headers).map(([name, value]) => ({
    name,
    value: sanitizeValue(name, value),
  }));
}

function safeUrl(rawUrl) {
  const url = new URL(rawUrl);
  for (const key of url.searchParams.keys()) {
    if (sensitiveName.test(key)) url.searchParams.set(key, REDACTED);
  }
  return url.toString();
}

async function findPage() {
  const targets = await fetch(`${CDP_HOST}/json`).then((response) => response.json());
  const page = targets.find(
    (target) =>
      target.type === "page" && target.url.includes(URL_MATCH),
  );
  if (!page) {
    throw new Error(`No page matching "${URL_MATCH}" is available on the Chrome debugging port`);
  }
  return page;
}

function createClient(webSocketUrl) {
  const socket = new WebSocket(webSocketUrl);
  const pending = new Map();
  const listeners = new Map();
  let nextId = 1;

  socket.addEventListener("message", ({ data }) => {
    const message = JSON.parse(data);
    if (message.id) {
      const waiter = pending.get(message.id);
      if (!waiter) return;
      pending.delete(message.id);
      if (message.error) waiter.reject(new Error(message.error.message));
      else waiter.resolve(message.result ?? {});
      return;
    }

    for (const listener of listeners.get(message.method) ?? []) {
      listener(message.params ?? {});
    }
  });

  const ready = new Promise((resolveReady, reject) => {
    socket.addEventListener("open", resolveReady, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });

  return {
    ready,
    on(method, listener) {
      const methodListeners = listeners.get(method) ?? [];
      methodListeners.push(listener);
      listeners.set(method, methodListeners);
    },
    async send(method, params = {}) {
      await ready;
      const id = nextId++;
      return new Promise((resolveCommand, reject) => {
        pending.set(id, { resolve: resolveCommand, reject });
        socket.send(JSON.stringify({ id, method, params }));
      });
    },
    close() {
      socket.close();
    },
  };
}

const page = await findPage();
const client = createClient(page.webSocketDebuggerUrl);
const records = new Map();
const bodyReads = new Set();

client.on("Network.requestWillBeSent", ({ requestId, request, timestamp, wallTime, type }) => {
  records.set(requestId, {
    requestId,
    request,
    type,
    startedDateTime: new Date(wallTime * 1_000).toISOString(),
    startedAt: timestamp,
  });
});

client.on("Network.responseReceived", ({ requestId, response, timestamp, type }) => {
  const record = records.get(requestId);
  if (!record) return;
  Object.assign(record, { response, type, respondedAt: timestamp });
});

client.on("Network.loadingFinished", ({ requestId, timestamp, encodedDataLength }) => {
  const record = records.get(requestId);
  if (!record) return;
  Object.assign(record, { finishedAt: timestamp, encodedDataLength });

  if (!record.response || !["Fetch", "XHR"].includes(record.type)) return;
  const bodyRead = client
    .send("Network.getResponseBody", { requestId })
    .then(({ body, base64Encoded }) => {
      record.body = body;
      record.base64Encoded = base64Encoded;
    })
    .catch(() => {})
    .finally(() => bodyReads.delete(bodyRead));
  bodyReads.add(bodyRead);
});

await Promise.all([
  client.send("Network.enable", { maxTotalBufferSize: 100_000_000 }),
  client.send("Page.enable"),
]);
await client.send("Network.setCacheDisabled", { cacheDisabled: true });
await client.send("Page.reload", { ignoreCache: true });
await new Promise((resolveWait) => setTimeout(resolveWait, WAIT_MS));
await Promise.allSettled([...bodyReads]);
client.close();

const entries = [...records.values()]
  .filter((record) => record.response)
  .map((record) => {
    const requestUrl = safeUrl(record.request.url);
    const postData = sanitizePostData(record.request.postData);
    const duration = Math.max(0, (record.finishedAt - record.startedAt) * 1_000 || 0);
    const wait = Math.max(0, (record.respondedAt - record.startedAt) * 1_000 || 0);
    const receive = Math.max(0, duration - wait);

    return {
      startedDateTime: record.startedDateTime,
      time: duration,
      request: {
        method: record.request.method,
        url: requestUrl,
        httpVersion: "HTTP/2",
        headers: headersToHar(record.request.headers),
        queryString: [...new URL(requestUrl).searchParams].map(([name, value]) => ({
          name,
          value,
        })),
        cookies: [],
        headersSize: -1,
        bodySize: postData?.length ?? 0,
        ...(postData
          ? {
              postData: {
                mimeType: record.request.headers?.["content-type"] ?? "application/json",
                text: postData,
              },
            }
          : {}),
      },
      response: {
        status: record.response.status,
        statusText: record.response.statusText,
        httpVersion: record.response.protocol,
        headers: headersToHar(record.response.headers),
        cookies: [],
        content: {
          size: record.encodedDataLength ?? -1,
          mimeType: record.response.mimeType,
          ...(record.body
            ? {
                text: sanitizeResponseBody(record.body, record.response.mimeType),
                ...(record.base64Encoded ? { encoding: "base64" } : {}),
              }
            : {}),
        },
        redirectURL: "",
        headersSize: -1,
        bodySize: record.encodedDataLength ?? -1,
      },
      cache: {},
      timings: { send: 0, wait, receive },
      _resourceType: record.type,
    };
  });

const har = {
  log: {
    version: "1.2",
    creator: { name: "nz-grocery-prices capture", version: "0.1.0" },
    pages: [
      {
        startedDateTime: entries[0]?.startedDateTime ?? new Date().toISOString(),
        id: URL_MATCH.replaceAll(/[^a-z0-9]+/gi, "-"),
        title: page.title,
        pageTimings: {},
      },
    ],
    entries,
  },
};

await mkdir(dirname(OUTPUT), { recursive: true });
await writeFile(OUTPUT, `${JSON.stringify(har, null, 2)}\n`);

const dataRequests = entries.filter((entry) =>
  ["Fetch", "XHR"].includes(entry._resourceType),
);
console.log(`Captured ${entries.length} requests (${dataRequests.length} data requests)`);
for (const entry of dataRequests) {
  console.log(`${entry.response.status} ${entry.request.method} ${entry.request.url}`);
}
console.log(`Sanitized HAR: ${OUTPUT}`);
