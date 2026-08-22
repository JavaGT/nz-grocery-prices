import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseObservation, validateObservation } from "../../src/domain/observation.js";

function validObservation(overrides = {}) {
  return {
    product: {
      id: overrides.productId ?? "prod:1",
      name: "Anchor Milk 2L",
    },
    store: {
      id: overrides.storeId ?? "store:1",
      retailer: overrides.retailer ?? "woolworths",
      name: "Store Name",
    },
    price: {
      regularCents: overrides.regularCents ?? 349,
      promoCents: overrides.promoCents,
      memberCents: overrides.memberCents,
    },
    source: {
      retailerProductId: overrides.retailerProductId ?? "5002984",
    },
    observedAt: overrides.observedAt ?? "2026-08-23T00:00:00.000Z",
    promotion: overrides.promotion,
    ...overrides.extra,
  };
}

describe("validateObservation", () => {
  it("returns no problems for a valid minimal observation", () => {
    assert.deepEqual(validateObservation(validObservation()), []);
  });

  it("accepts optional constrained fields when valid", () => {
    const observation = validObservation({
      promoCents: 299,
      memberCents: 0,
      promotion: {
        startsAt: "2026-08-20T00:00:00.000Z",
        endsAt: "2026-08-30T00:00:00.000Z",
        savePercent: 14,
      },
    });
    assert.deepEqual(validateObservation(observation), []);
  });

  it("flags missing product.id", () => {
    const problems = validateObservation(validObservation({ productId: "" }));
    assert.ok(problems.some((problem) => problem.includes("product.id")));
  });

  it("flags empty store.id", () => {
    const problems = validateObservation(validObservation({ storeId: "" }));
    assert.ok(problems.some((problem) => problem.includes("store.id")));
  });

  it("flags missing store.retailer", () => {
    const problems = validateObservation(validObservation({ retailer: "" }));
    assert.ok(problems.some((problem) => problem.includes("store.retailer")));
  });

  it("flags negative regularCents", () => {
    const problems = validateObservation(validObservation({ regularCents: -1 }));
    assert.ok(problems.some((problem) => problem.includes("price.regularCents")));
  });

  it("flags non-integer regularCents", () => {
    const problems = validateObservation(validObservation({ regularCents: 3.49 }));
    assert.ok(problems.some((problem) => problem.includes("price.regularCents")));
  });

  it("flags non-integer promoCents when present", () => {
    const problems = validateObservation(validObservation({ promoCents: "299" }));
    assert.ok(problems.some((problem) => problem.includes("price.promoCents")));
  });

  it("flags non-integer memberCents when present", () => {
    const problems = validateObservation(validObservation({ memberCents: 2.99 }));
    assert.ok(problems.some((problem) => problem.includes("price.memberCents")));
  });

  it("flags non-ISO observedAt", () => {
    const problems = validateObservation(validObservation({ observedAt: "23/08/2026" }));
    assert.ok(problems.some((problem) => problem.includes("observedAt")));
  });

  it("flags missing source.retailerProductId", () => {
    const problems = validateObservation(validObservation({ retailerProductId: "" }));
    assert.ok(problems.some((problem) => problem.includes("source.retailerProductId")));
  });

  it("flags promotion.endsAt that is not ISO", () => {
    const problems = validateObservation(
      validObservation({ promotion: { endsAt: "next friday" } }),
    );
    assert.ok(problems.some((problem) => problem.includes("promotion.endsAt")));
  });

  it("flags promotion.savePercent that is not a number", () => {
    const problems = validateObservation(
      validObservation({ promotion: { savePercent: "14%" } }),
    );
    assert.ok(problems.some((problem) => problem.includes("promotion.savePercent")));
  });

  it("allows unknown extra fields at any level", () => {
    const observation = validObservation();
    observation.futureField = { anything: true };
    observation.price.centsOfKindness = 42;
    assert.deepEqual(validateObservation(observation), []);
  });

  it("collects every problem at once, not just the first", () => {
    const observation = validObservation({ productId: "", regularCents: -1 });
    const problems = validateObservation(observation);
    assert.equal(problems.length, 2);
    assert.ok(problems.every((problem) => typeof problem === "string"));
  });

  it("never throws on malformed input", () => {
    assert.doesNotThrow(() => validateObservation(null));
    assert.deepEqual(validateObservation(null), ["observation must be an object"]);
    assert.deepEqual(validateObservation("nope"), ["observation must be an object"]);
  });
});

describe("parseObservation", () => {
  it("returns the observation unchanged when valid", () => {
    const observation = validObservation();
    assert.strictEqual(parseObservation(observation), observation);
  });

  it("throws a TypeError listing every problem joined by '; '", () => {
    const observation = validObservation({ productId: "", regularCents: -1 });
    assert.throws(() => parseObservation(observation), (error) => {
      assert.ok(error instanceof TypeError);
      const message = error.message;
      assert.ok(message.includes("; "));
      assert.ok(message.includes("product.id must be a non-empty string"));
      assert.ok(message.includes("price.regularCents must be a non-negative integer"));
      return true;
    });
  });

  it("does not throw for observations with only extra unknown fields", () => {
    const observation = validObservation();
    observation.somethingNew = 1;
    assert.deepEqual(parseObservation(observation), observation);
  });
});
