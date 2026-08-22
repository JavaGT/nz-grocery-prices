import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { stable, fingerprint } from "../../src/domain/fingerprint.js";

describe("stable", () => {
  it("sorts object keys lexicographically", () => {
    assert.deepEqual(stable({ b: 2, a: 1, c: 3 }), { a: 1, b: 2, c: 3 });
  });

  it("omits undefined-valued keys but keeps null and false", () => {
    const result = stable({ gone: undefined, keepNull: null, keepFalse: false, keepZero: 0 });
    assert.deepEqual(result, { keepNull: null, keepFalse: false, keepZero: 0 });
  });

  it("normalizes nested objects recursively", () => {
    const result = stable({ outer: { z: 1, a: { y: undefined, x: 2 } } });
    assert.deepEqual(result, { outer: { a: { x: 2 }, z: 1 } });
  });

  it("maps arrays in order without sorting elements", () => {
    assert.deepEqual(stable(["b", "a"]), ["b", "a"]);
    assert.deepEqual(stable([{ b: 1, a: 2 }]), [{ a: 2, b: 1 }]);
  });

  it("passes scalars through untouched", () => {
    assert.equal(stable(42), 42);
    assert.equal(stable("hello"), "hello");
    assert.equal(stable(null), null);
    assert.equal(stable(undefined), undefined);
  });
});

describe("fingerprint", () => {
  const observation = {
    store: { retailer: "woolworths", id: "store:1" },
    product: { id: "prod:1", name: "Milk" },
    observedAt: "2026-08-23T00:00:00.000Z",
    price: { regularCents: 349, promoCents: undefined, memberCents: 299 },
    source: { retailerProductId: "111" },
    tags: ["fresh", "chilled"],
    meta: undefined,
  };

  // Golden digests computed from the original algorithm in src/repository.js;
  // byte-stability across runs is load-bearing for archive dedup.
  it("produces the same digest as the repository.js algorithm for a full observation", () => {
    assert.equal(
      fingerprint(observation),
      "efb8d0cb952ef6783834b4e014e40138cb4c724beb8c5ccded17bc34f1680baf",
    );
  });

  it("returns the pinned digest for nested objects with undefined fields", () => {
    assert.equal(
      fingerprint({ b: 2, a: { z: 1, y: [3, 1, 2] }, c: undefined }),
      "c4db553b99c414922a5695ace96363c5a6c01d21f2706062d2f643ab358e7485",
    );
  });

  it("gives the same hash for the same object hashed twice", () => {
    assert.equal(fingerprint(observation), fingerprint(observation));
  });

  it("ignores key insertion order", () => {
    const reordered = {
      meta: undefined,
      tags: ["fresh", "chilled"],
      source: { retailerProductId: "111" },
      price: { memberCents: 299, promoCents: undefined, regularCents: 349 },
      observedAt: "2026-08-23T00:00:00.000Z",
      product: { name: "Milk", id: "prod:1" },
      store: { id: "store:1", retailer: "woolworths" },
    };
    assert.equal(fingerprint(reordered), fingerprint(observation));
  });

  it("ignores undefined-valued fields wherever they appear", () => {
    const withoutUndefined = JSON.parse(JSON.stringify(observation));
    assert.equal(fingerprint(withoutUndefined), fingerprint(observation));
  });

  it("treats array element order as significant", () => {
    assert.notEqual(fingerprint([1, 2, 3]), fingerprint([3, 2, 1]));
    assert.equal(
      fingerprint([1, 2, 3]),
      "a615eeaee21de5179de080de8c3052c8da901138406ba71c38c032845f7d54f4",
    );
  });

  it("hashes scalars to their pinned digests", () => {
    assert.equal(fingerprint("hello"), "5aa762ae383fbb727af3c7a36d4940a5b8c40a989452d2304fc958ff3f354e7a");
    assert.equal(fingerprint(42), "73475cb40a568e8da8a045ced110137e159f890ac4da883b6b17dc651b3a8049");
    assert.equal(fingerprint(null), "74234e98afe7498fb5daf1f36ac2d78acc339464f950703b8c019892f982b90b");
    assert.equal(fingerprint(true), "b5bea41b6c623f7c09f1bf24dcae58ebab3c0cdd90ad966bc43a45b44867e12b");
  });
});
