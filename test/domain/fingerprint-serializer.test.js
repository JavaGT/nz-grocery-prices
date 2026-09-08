import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { stable, fingerprint } from "../../src/archive-records.js";

/**
 * fingerprint() serializes via a direct canonical writer (canonicalJson)
 * instead of JSON.stringify(stable(value)). These tests pin the serializer
 * to the reference implementation on the shapes where the two could drift:
 * key-order quirks (integer-like keys), undefined handling, numeric forms,
 * string escaping, and exotic-value error behavior. Digest equality on
 * identical canonical bytes is the assertion — sha256 collisions are not a
 * realistic failure mode.
 */
function referenceDigest(value) {
  return createHash("sha256").update(JSON.stringify(stable(value))).digest("hex");
}

function assertSameDigest(value) {
  assert.equal(fingerprint(value), referenceDigest(value));
}

describe("fingerprint serializer parity with JSON.stringify(stable(...))", () => {
  it("matches on numeric forms (negatives, -0, exponents, non-finite, MAX_SAFE)", () => {
    for (const value of [0, -0, 42, -42, 3.14, 1e21, -1e-7, NaN, Infinity, -Infinity, 9007199254740991]) {
      assertSameDigest(value);
      assertSameDigest({ key: value });
      assertSameDigest([value]);
    }
  });

  it("matches on strings needing escapes and plain strings", () => {
    assertSameDigest("plain");
    assertSameDigest('quote " backslash \\ control \t \n');
    assertSameDigest({ "key\twith\\escape": "value\nwith\"quote" });
  });

  it("emits integer-like keys in ascending numeric order before string keys", () => {
    // Object.fromEntries reorders integer-like keys numerically ahead of
    // string keys, so the reference output does too — regardless of the
    // locale-pinned sort. The serializer must reproduce that order.
    assertSameDigest({ 1: "one", 10: "ten", 2: "two" });
    assertSameDigest({ "10": "ten", "2": "two", b: 1, a: 2, "0": "zero" });
    assertSameDigest({ "4294967294": "max index", "4294967295": "not an index" });
    assertSameDigest({ "01": "leading zero is a string key", 1: "index" });
  });

  it("drops undefined-valued keys but maps undefined array elements to null", () => {
    assertSameDigest({ gone: undefined, kept: null, alsoKept: false, zero: 0 });
    assertSameDigest([undefined, 1, undefined]);
    assertSameDigest({ nested: { deeper: { gone: undefined } } });
  });

  it("matches on arrays including sparse-like hole positions and nesting", () => {
    const sparse = [1, , 3]; // eslint-disable-line no-sparse-arrays
    assertSameDigest(sparse);
    assertSameDigest([[["deep"]], {}]);
  });

  it("matches on non-plain objects (hashed like their enumerable shape)", () => {
    assertSameDigest(new Date(0));
    assertSameDigest(Object.assign(Object.create({ hidden: 1 }), { own: 1 }));
  });

  it("invokes getters exactly once per fingerprint", () => {
    let calls = 0;
    const object = {};
    Object.defineProperty(object, "g", {
      enumerable: true,
      get() {
        calls += 1;
        return calls;
      },
    });
    fingerprint(object);
    assert.equal(calls, 1);
  });

  it("throws the identical BigInt TypeError as JSON.stringify", () => {
    let referenceError;
    try {
      referenceDigest({ big: 1n });
    } catch (error) {
      referenceError = error;
    }
    assert.ok(referenceError instanceof TypeError);
    assert.throws(() => fingerprint({ big: 1n }), (error) => error.message === referenceError.message);
  });

  it("keys of one object are hashed independently of insertion order", () => {
    assert.equal(
      fingerprint({ b: { y: 1, x: 2 }, a: 1 }),
      fingerprint({ a: 1, b: { x: 2, y: 1 } }),
    );
  });
});
