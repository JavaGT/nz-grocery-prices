import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseArgs, assertNotLiveArchive } from "../scripts/warehouse-breadth.js";

describe("quick script import test", () => {
  it("works", () => {
    assert.equal(typeof parseArgs, "function");
  });
});