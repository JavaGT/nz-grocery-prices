// Parity proof: fingerprint()'s fast serializer must produce the same digest
// as sha256 over the reference canonical JSON, JSON.stringify(stable(v)).
// Run: node /tmp/ingest-perf/parity-fp.mjs <archive.jsonl> [more.jsonl ...]
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { stable, fingerprint } from "/Users/server/Development/perf-trial-2026-09-09T100601-ingest/src/archive-records.js";

function referenceDigest(value) {
  // Throws exactly where the old implementation threw (e.g. BigInt).
  return createHash("sha256").update(JSON.stringify(stable(value))).digest("hex");
}

const edgeCases = [
  0, -0, 42, 3.14, 1e21, -1e-7, NaN, Infinity, -Infinity, 9007199254740991,
  "", "hello", 'quote"inside', "back\\slash", "tab\tnewline\n",
  null, true, false,
  [], [1, 2, 3], [null, undefined, 1], [[]], [[[[1]]]], ["b", "a"],
  {}, { a: 1 }, { b: 2, a: 1 }, { z: undefined, a: 1 },
  { nested: { inner: { b: 1, a: 2 } } },
  { arr: [{ y: 1, x: 2 }, { w: 3, v: 4 }] },
  { mixed: [1, "two", { three: 3 }, null, true] },
  { empty: {}, emptyArr: [], nil: null },
  { price: { regularCents: 349, promoCents: undefined, memberCents: 299 } },
  { zebra: 1, Apple: 2, apple: 3, Banana: 4, "\u00e4rger": 5, azz: 6 },
  { a: { "\u00df": 1, ss: 2 } },
  { 1: "numeric key", 10: "ten", 2: "two" },
  { "": "empty key", x: 1 },
  { own: 1 },
  new Date(0),
  Object.assign(Object.create({ inherited: 1 }), { own: 1 }),
  { undefinedOnly: undefined },
  [{ deep: [{ deeper: [{ deepest: undefined }] }] }],
];

let getterCalls = 0;
const getterObj = {};
Object.defineProperty(getterObj, "g", { enumerable: true, get() { getterCalls += 1; return 42; } });
edgeCases.push(getterObj);

let checked = 0;
let mismatches = 0;

function check(value, label) {
  checked += 1;
  let ref, refErr, fast, fastErr;
  try { ref = referenceDigest(value); } catch (e) { refErr = e; }
  try { fast = fingerprint(value); } catch (e) { fastErr = e; }
  if (refErr || fastErr) {
    if (!refErr || !fastErr) {
      mismatches += 1;
      console.log(`MISMATCH (throw asymmetry) ${label}: ref=${refErr?.message} fast=${fastErr?.message}`);
    } else if (refErr.name !== fastErr.name || refErr.message !== fastErr.message) {
      mismatches += 1;
      console.log(`MISMATCH (error text) ${label}: ref=${refErr.message} fast=${fastErr.message}`);
    }
    return;
  }
  if (ref !== fast) {
    mismatches += 1;
    console.log(`MISMATCH ${label}: ref=${ref} fast=${fast}`);
  }
}

edgeCases.forEach((value, i) => check(value, `edge[${i}]`));
check(getterObj, "getter-object");
if (getterCalls !== 2) {
  console.log(`NOTE: getter invoked ${getterCalls} times (2 checks) - semantics changed if != 2`);
}

// BigInt: both must throw the identical TypeError
check({ big: 1n }, "bigint");

// Real archive payloads
for (const path of process.argv.slice(2)) {
  const lines = readFileSync(path, "utf8").split("\n");
  let payloads = 0;
  for (const line of lines) {
    if (!line) continue;
    const record = JSON.parse(line);
    if (record.type === "product" || record.type === "offer" || record.type === "store") {
      check(record.data, `${path} line ${payloads}`);
      payloads += 1;
    }
  }
  console.log(`${path}: ${payloads} payloads checked`);
}

console.log(`total checked: ${checked}, mismatches: ${mismatches}`);
process.exit(mismatches === 0 ? 0 : 1);
