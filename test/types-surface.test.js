/**
 * CORE-5 public-surface gates.
 *
 * There is no TypeScript compiler in this repo, so the hand-maintained
 * .d.ts contract is verified three ways instead:
 *
 *   1. the runtime root export-name set is EXACTLY the CORE-5 list;
 *   2. structural assertions on src/index.d.ts (every runtime export is
 *      declared, required parameters stay required, no internals leak);
 *   3. consumer-style fixture modules are written to a temp dir, imported,
 *      and their results are checked field-by-field against BOTH the
 *      documented interfaces and the actual runtime outputs — so either
 *      side drifting fails here.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import * as publicSurface from "../src/index.js";

const ROOT_DIR = join(import.meta.dirname, "..");
const DTS_PATH = join(ROOT_DIR, "src", "index.d.ts");

/** CORE-5: the entire allowed root export list. */
const ROOT_EXPORTS = [
  "PriceArchive",
  "JsonlObservationRepository",
  "MemoryObservationRepository",
  "parseObservation",
  "calculateSales",
  "calculateOngoingSales",
  "buildPriceSeries",
  "toAgentFeed",
];

/** Internals and adapter APIs that must never reappear at the root. */
const FORBIDDEN_AT_ROOT = [
  "ArchiveIndex",
  "validateObservation",
  "filterObservations",
  "observationKey",
  "withArchiveLock",
  "acquireArchiveLock",
  "readArchiveLines",
  "decodeArchiveLine",
  "writeAllAndSync",
  "fingerprint",
  "encodeRecord",
  "classifyParsedRecord",
  "FoodstuffsClient",
  "PaknsaveClient",
  "NewWorldClient",
  "WoolworthsClient",
  "FreshChoiceClient",
  "WarehouseClient",
  "toPriceObservation",
  "toWoolworthsObservation",
  "toFreshChoiceObservation",
  "toWarehouseObservation",
  "parseFreshChoiceProducts",
  "parseWarehouseProducts",
];

const ADAPTER_DTS_FILES = [
  "src/adapters/foodstuffs.d.ts",
  "src/adapters/woolworths.d.ts",
  "src/adapters/freshchoice.d.ts",
  "src/adapters/warehouse.d.ts",
];

// ---- .d.ts structural helpers ----

async function readIndexDts() {
  return readFile(DTS_PATH, "utf8");
}

/** Names of every `export declare class|function|interface|type` in the file. */
function declaredExportNames(source) {
  const patterns = [
    /^export declare class (\w+)/gm,
    /^export function (\w+)/gm,
    /^export interface (\w+)/gm,
    /^export type (\w+)/gm,
  ];
  return [
    ...new Set(patterns.flatMap((pattern) => [...source.matchAll(pattern)].map((m) => m[1]))),
  ].sort();
}

/** Top-level property names of one interface block (two-space indent). */
function interfaceProps(source, name) {
  const block = source.match(new RegExp(`export interface ${name} \\{[\\s\\S]*?\\n\\}`))?.[0];
  assert.ok(block, `index.d.ts must declare interface ${name}`);
  return [...block.matchAll(/^ {2}(\w+)(\?)?:/gm)].map((match) => match[1]).sort();
}

/** The signature block of one exported function (up to the next export). */
function functionBlock(source, name) {
  const start = source.indexOf(`export function ${name}`);
  assert.ok(start !== -1, `index.d.ts must declare function ${name}`);
  const next = source.indexOf("\nexport ", start + 1);
  return source.slice(start, next === -1 ? undefined : next);
}

// ---- Gates ----

test("root export set is exactly the CORE-5 list", () => {
  assert.deepEqual(Object.keys(publicSurface).sort(), [...ROOT_EXPORTS].sort());
});

test("package exports map publishes the declared contract for every subpath", async () => {
  const pkg = JSON.parse(await readFile(join(ROOT_DIR, "package.json"), "utf8"));
  assert.equal(pkg.name, "nz-grocery-prices");
  // Root: types must sit next to the runtime module the exports map names.
  assert.equal(pkg.exports["."].types, "./src/index.d.ts");
  assert.equal(pkg.exports["."].import, "./src/index.js");
  // Each adapter subpath pairs its declaration with its implementation.
  for (const relative of ADAPTER_DTS_FILES) {
    const name = `./${relative.replace(/^src\/adapters\//, "").replace(/\.d\.ts$/, "")}`;
    const entry = pkg.exports[name];
    assert.ok(entry, `exports map must expose ${name}`);
    assert.equal(entry.types, `./${relative}`);
    assert.equal(entry.import, `./${relative.replace(/\.d\.ts$/, ".js")}`);
  }
});

test("index.d.ts declares every runtime export and nothing forbidden", async () => {
  const source = await readIndexDts();
  const declared = declaredExportNames(source);

  for (const name of ROOT_EXPORTS) {
    assert.ok(
      declared.includes(name),
      `index.d.ts must declare runtime export ${name}`,
    );
  }
  for (const name of FORBIDDEN_AT_ROOT) {
    assert.ok(!declared.includes(name), `${name} must not be a root export`);
    assert.ok(!source.includes(`export { ${name}`), `${name} must not be re-exported`);
  }
  // Value declarations must be honest: the three runtime classes as
  // classes, the five runtime functions as functions.
  const classExports = [
    "PriceArchive",
    "JsonlObservationRepository",
    "MemoryObservationRepository",
  ];
  const functionExports = [
    "parseObservation",
    "calculateSales",
    "calculateOngoingSales",
    "buildPriceSeries",
    "toAgentFeed",
  ];
  for (const name of classExports) {
    assert.match(
      source,
      new RegExp(`^export declare class ${name}\\b`, "m"),
      `${name} must be declared as a class`,
    );
  }
  for (const name of functionExports) {
    assert.match(
      source,
      new RegExp(`^export function ${name}\\b`, "m"),
      `${name} must be declared as a function`,
    );
  }
});

test("analytics signatures keep the deterministic at-required contract", async () => {
  const source = await readIndexDts();
  for (const name of ["calculateSales", "calculateOngoingSales"]) {
    const block = functionBlock(source, name);
    assert.match(block, /\bat: string\b/, `${name} must require a string at`);
    assert.doesNotMatch(block, /at\?:/, `${name} must not make at optional`);
  }
});

test("agent feed stays a stable two-list contract in the declarations", async () => {
  const source = await readIndexDts();
  assert.deepEqual(interfaceProps(source, "AgentFeed"), [
    "currency",
    "generatedAt",
    "ongoingSales",
    "sales",
  ]);
  // Advertised vs history-backed entries carry distinct evidence fields.
  assert.deepEqual(interfaceProps(source, "AgentFeedHistorySale"), [
    "baselineAverageCents",
    "baselineSampleCount",
    "brand",
    "currentCents",
    "dropPercent",
    "isAllTimeLow",
    "observedAt",
    "priceKind",
    "productId",
    "productName",
    "promotion",
    "retailer",
    "storeId",
    "storeName",
  ]);
  assert.deepEqual(interfaceProps(source, "AgentFeedOngoingSale"), [
    "brand",
    "currentCents",
    "gtin",
    "observedAt",
    "priceKind",
    "productId",
    "productName",
    "promotion",
    "regularCents",
    "retailer",
    "savePercent",
    "storeId",
    "storeName",
  ]);
});

test("adapter contracts no longer import types from the root", async () => {
  for (const relative of ADAPTER_DTS_FILES) {
    const source = await readFile(join(ROOT_DIR, relative), "utf8");
    assert.ok(
      !source.includes("../index.js"),
      `${relative} must be self-contained (root no longer exports domain types)`,
    );
  }
});

test("adapter declarations share the single domain source — no local copies", async () => {
  for (const relative of ADAPTER_DTS_FILES) {
    const source = await readFile(join(ROOT_DIR, relative), "utf8");
    assert.ok(
      source.includes('from "../domain/observation.js"'),
      `${relative} must import the shared domain contract`,
    );
    assert.match(
      source,
      /export type \{ PriceObservation, Store \};/,
      `${relative} must re-export the shared shapes`,
    );
    assert.doesNotMatch(
      source,
      /export interface (Store|PriceObservation) \{/,
      `${relative} must not redeclare domain shapes (drift risk)`,
    );
  }
});

test("agent-feed name fields are optional in .d.ts AND undefined at runtime without names", async () => {
  const source = await readIndexDts();
  for (const name of ["AgentFeedHistorySale", "AgentFeedOngoingSale"]) {
    const block = source.match(
      new RegExp(`export interface ${name} \\{[\\s\\S]*?\\n\\}`),
    )?.[0];
    assert.ok(block, `index.d.ts must declare ${name}`);
    assert.match(block, /productName\?: string/, `${name}.productName must be optional`);
    assert.match(block, /storeName\?: string/, `${name}.storeName must be optional`);
  }

  // Runtime truth: an observation whose product/store carry no names must
  // produce feed entries where those fields are present-but-undefined.
  const indexUrl = pathToFileURL(join(ROOT_DIR, "src", "index.js")).href;
  const result = await runConsumerFixture(
    "consumer-agentfeed-names.mjs",
    `
import { calculateOngoingSales, toAgentFeed } from "${indexUrl}";

// No product.name, no store.name — only the required identity fields.
const observations = [{
  product: { id: "foodstuffs:nameless" },
  store: { id: "paknsave:001", retailer: "paknsave" },
  price: { regularCents: 500, promoCents: 350 },
  promotion: {
    startsAt: "2026-08-19T00:00:00.000Z",
    endsAt: "2026-08-25T00:00:00.000Z",
  },
  observedAt: "2026-08-20T00:00:00.000Z",
  source: { retailerProductId: "5226969-ea-000" },
}];
const AT = "2026-08-21T00:00:00.000Z";
const ongoing = calculateOngoingSales(observations, { at: AT });
const feed = toAgentFeed([], AT, ongoing);
const item = feed.ongoingSales[0];
export default {
  hasOngoing: ongoing.length === 1 && item !== undefined,
  productNameUndefined: item?.productName === undefined,
  storeNameUndefined: item?.storeName === undefined,
};
`,
  );
  assert.equal(result.hasOngoing, true, "fixture must produce one ongoing sale entry");
  assert.equal(result.productNameUndefined, true);
  assert.equal(result.storeNameUndefined, true);
});

// ---- Consumer fixtures ----

/**
 * Writes a fixture module that consumes the library exactly as the .d.ts
 * documents it, runs it, and returns its exported result. Fixtures live in
 * a temp dir and import src/index.js by absolute file URL — the same module
 * the package exports map publishes. (Package self-reference can't be used
 * from outside the package directory.)
 */
async function runConsumerFixture(fixtureName, fixtureSource) {
  const dir = await mkdtemp(join(tmpdir(), "nzgp-types-"));
  try {
    const fixturePath = join(dir, fixtureName);
    await writeFile(fixturePath, fixtureSource);
  return (await import(pathToFileURL(fixturePath).href)).default;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const OBSERVATIONS = [
  {
    product: { id: "foodstuffs:5226969-ea-000", name: "Butter 500g", brand: "Anchor", gtin: "9400600000000" },
    store: { id: "paknsave:001", retailer: "paknsave", name: "Royal Oak" },
    price: { currency: "NZD", regularCents: 500 },
    observedAt: "2026-07-01T00:00:00.000Z",
    source: { retailerProductId: "5226969-ea-000", adapter: "foodstuffs-paknsave" },
  },
  {
    product: { id: "foodstuffs:5226969-ea-000", name: "Butter 500g", brand: "Anchor", gtin: "9400600000000" },
    store: { id: "paknsave:001", retailer: "paknsave", name: "Royal Oak" },
    price: { currency: "NZD", regularCents: 520 },
    observedAt: "2026-07-15T00:00:00.000Z",
    source: { retailerProductId: "5226969-ea-000", adapter: "foodstuffs-paknsave" },
  },
  {
    product: { id: "foodstuffs:5226969-ea-000", name: "Butter 500g", brand: "Anchor", gtin: "9400600000000" },
    store: { id: "paknsave:001", retailer: "paknsave", name: "Royal Oak" },
    price: { currency: "NZD", regularCents: 500, promoCents: 350 },
    promotion: { startsAt: "2026-08-19T00:00:00.000Z", endsAt: "2026-08-25T00:00:00.000Z", savePercent: 30 },
    observedAt: "2026-08-20T00:00:00.000Z",
    lastSeenAt: "2026-08-20T12:00:00.000Z",
    isOnSpecial: true,
    source: { retailerProductId: "5226969-ea-000", adapter: "foodstuffs-paknsave" },
  },
];

test("consumer fixture: repositories, archive facade, and parseObservation honor the contract", async () => {
  const indexUrl = pathToFileURL(join(ROOT_DIR, "src", "index.js")).href;
  const result = await runConsumerFixture(
    "consumer-core.mjs",
    `
import {
  PriceArchive,
  JsonlObservationRepository,
  MemoryObservationRepository,
  parseObservation,
} from "${indexUrl}";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const observations = ${JSON.stringify(OBSERVATIONS)};
const AT = "2026-08-21T00:00:00.000Z";

// parseObservation validates and passes through unchanged...
const valid = parseObservation(observations[0]);
let invalidMessage;
try {
  parseObservation({ ...observations[0], price: { regularCents: -1 } });
} catch (error) {
  invalidMessage = error.message;
}

// ...and the archive facade accepts anything parseObservation allows.
const validIsIdentity = valid === observations[0];
const memory = new MemoryObservationRepository();
const appended = await memory.append(observations);
const archive = new PriceArchive(memory);
const history = await archive.history({ productId: "foodstuffs:5226969-ea-000" });
const revisions = await archive.productHistory("foodstuffs:5226969-ea-000");
const sales = await archive.findSales({ at: AT, minSamples: 2 });
const ongoing = await archive.ongoingSales({ at: AT });
const feed = await archive.agentFeed({ at: AT });

// JSONL repository: constructor path, durable append, query, compact, stats.
const fileDir = await mkdtemp(join(tmpdir(), "nzgp-jsonl-"));
const jsonl = new JsonlObservationRepository(join(fileDir, "prices.jsonl"));
const persisted = await jsonl.append(observations);
const queried = await jsonl.query({ retailer: "paknsave" });
const compaction = await jsonl.compact();
const stats = await jsonl.stats();
const defects = jsonl.getLoadDefects();

const result = {
  appended,
  archived: { history, revisions, sales, ongoing, feed },
  jsonl: { persisted, queried, compaction, stats, defects },
  parse: { valid, invalidMessage, validIsIdentity },
};
export default result;
`,
  );

  // Repository seam.
  assert.equal(result.appended, 3);

  // Facade queries return the documented shapes.
  assert.equal(result.archived.history.length, 3);
  assert.deepEqual(Object.keys(result.archived.revisions[0]).sort(), [
    "hash",
    "observedAt",
    "product",
  ]);
  assert.equal(result.archived.sales.length, 1);
  assert.deepEqual(interfaceProps(await readIndexDts(), "Sale"), Object.keys(result.archived.sales[0]).sort());
  assert.deepEqual(Object.keys(result.archived.sales[0].baseline).sort(), [
    "averageCents",
    "days",
    "sampleCount",
  ]);
  assert.deepEqual(Object.keys(result.archived.sales[0].current).sort(), [
    "cents",
    "kind",
    "observedAt",
  ]);
  assert.equal(result.archived.ongoing.length, 1);
  assert.deepEqual(
    interfaceProps(await readIndexDts(), "OngoingSale"),
    Object.keys(result.archived.ongoing[0]).sort(),
  );
  assert.deepEqual(interfaceProps(await readIndexDts(), "AgentFeed"), Object.keys(result.archived.feed).sort());

  // JSONL persistence path honors its documented methods. append() counts
  // archive RECORDS (1 product revision + 1 store revision + 3 offer
  // revisions = 5), not raw observations like the memory repository.
  assert.equal(result.jsonl.persisted, 5);
  assert.equal(result.jsonl.queried.length, 3);
  assert.ok(result.jsonl.compaction.records >= 1);
  assert.deepEqual(interfaceProps(await readIndexDts(), "ArchiveStats"), Object.keys(result.jsonl.stats).sort());

  // parseObservation: identity in-module when valid, TypeError naming paths
  // when not. (The returned object crosses the fixture boundary by JSON, so
  // only the in-fixture reference check can prove identity.)
  assert.equal(result.parse.validIsIdentity, true);
  assert.deepEqual(result.parse.valid, OBSERVATIONS[0]);
  assert.match(result.parse.invalidMessage, /price\.regularCents/);
});

test("consumer fixture: pure analytics honor the declared signatures", async () => {
  const indexUrl = pathToFileURL(join(ROOT_DIR, "src", "index.js")).href;
  const result = await runConsumerFixture(
    "consumer-analytics.mjs",
    `
import {
  buildPriceSeries,
  calculateSales,
  calculateOngoingSales,
  toAgentFeed,
} from "${indexUrl}";

const observations = ${JSON.stringify(OBSERVATIONS)};
const AT = "2026-08-21T00:00:00.000Z";

// Deterministic contract: at is REQUIRED for both sale detectors.
let missingAtError;
try {
  calculateSales(observations, {});
} catch (error) {
  missingAtError = error.constructor.name;
}

const sales = calculateSales(observations, { at: AT, minSamples: 2 });
const ongoing = calculateOngoingSales(observations, { at: AT });
const series = buildPriceSeries(observations);
const feed = toAgentFeed(sales, AT, ongoing);

const result = { series, feed, feedless: toAgentFeed(sales, AT), missingAtError };
export default result;
`,
  );

  const dts = await readIndexDts();

  // Series shape: per-offer, points ascending with effective-price kinds.
  assert.deepEqual(interfaceProps(dts, "PriceSeries"), Object.keys(result.series[0]).sort());
  assert.deepEqual(interfaceProps(dts, "PriceSeriesPoint"), Object.keys(result.series[0].points[0]).sort());
  assert.deepEqual(
    result.series[0].points.map((point) => point.observedAt),
    [...result.series[0].points.map((point) => point.observedAt)].sort(),
  );
  assert.deepEqual(
    result.series[0].points.map((point) => point.kind),
    ["regular", "regular", "promo"],
  );

  // Feed entries expose the stable documented field sets.
  assert.deepEqual(
    interfaceProps(dts, "AgentFeedHistorySale"),
    Object.keys(result.feed.sales[0]).sort(),
  );
  assert.deepEqual(
    interfaceProps(dts, "AgentFeedOngoingSale"),
    Object.keys(result.feed.ongoingSales[0]).sort(),
  );
  // toAgentFeed's third argument is optional.
  assert.deepEqual(Object.keys(result.feedless).sort(), ["currency", "generatedAt", "ongoingSales", "sales"]);
  assert.equal(result.feedless.ongoingSales.length, 0);

  // The at-required contract holds at runtime too.
  assert.equal(result.missingAtError, "TypeError");
});
