import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  parseLine,
  groupRuns,
  nightHealth,
  streakFromNights,
} from "../scripts/breadth-pilot-gate.js";

// ---- fixture helpers -----------------------------------------------------

function line(stamp, retailer, exit, healthy) {
  return `${stamp} ${retailer} exit=${exit} ${JSON.stringify({ healthy })}`;
}

/** Full five-retailer run at a given UTC stamp. */
function run(stamp, healthy) {
  const exit = healthy ? 0 : 1;
  return [
    line(stamp, "paknsave", exit, healthy),
    line(stamp, "newworld", exit, healthy),
    line(stamp, "freshchoice", exit, healthy),
    line(stamp, "warehouse", exit, healthy),
    line(stamp, "woolworths", exit, healthy),
  ];
}

// ---- parseLine -----------------------------------------------------------

describe("parseLine", () => {
  it("parses a healthy line", () => {
    const entry = parseLine('2026-08-28T15:30:04Z paknsave exit=0 {"healthy":true}');
    assert.equal(entry.stamp, "2026-08-28T15:30:04Z");
    assert.equal(entry.retailer, "paknsave");
    assert.equal(entry.exit, 0);
    assert.equal(entry.healthy, true);
  });

  it("marks a non-zero exit as unhealthy even if a summary exists", () => {
    const entry = parseLine('2026-08-28T15:30:04Z newworld exit=1 {"healthy":true}');
    assert.equal(entry.healthy, false);
  });

  it("marks an unparseable summary as unhealthy", () => {
    const entry = parseLine("2026-08-28T15:30:04Z newworld exit=1 stack trace…");
    assert.equal(entry.healthy, false);
    assert.equal(entry.summary, null);
  });

  it("ignores blank lines", () => {
    assert.equal(parseLine("   "), null);
  });
});

// ---- night grouping and streak -------------------------------------------

describe("nightHealth + streakFromNights", () => {
  it("counts consecutive healthy nights from the most recent", () => {
    const lines = [
      ...run("2026-08-27T15:30:04Z", false), // night 1 (Aug 28 NZ): broken
      ...run("2026-08-28T15:30:04Z", true), // night 2 (Aug 29 NZ)
      ...run("2026-08-29T15:30:04Z", true), // night 3 (Aug 30 NZ)
    ];
    const nights = nightHealth(groupRuns(lines));
    const result = streakFromNights(nights);
    assert.equal(result.streak, 2);
    assert.deepEqual(result.healthyDates, ["2026-08-30", "2026-08-29"]);
    assert.equal(result.missingSince, "2026-08-28");
  });

  it("an all-healthy week yields the full streak", () => {
    const lines = [];
    for (let i = 27; i <= 30; i++) lines.push(...run(`2026-08-${i}T15:30:04Z`, true));
    const nights = nightHealth(groupRuns(lines));
    assert.equal(streakFromNights(nights).streak, 4);
  });

  it("a single partially-healthy run does not count", () => {
    const lines = [
      line("2026-08-28T15:30:04Z", "paknsave", 0, true),
      line("2026-08-28T15:30:04Z", "newworld", 1, false),
      line("2026-08-28T15:30:04Z", "freshchoice", 0, true),
      line("2026-08-28T15:30:04Z", "warehouse", 0, true),
      line("2026-08-28T15:30:04Z", "woolworths", 0, true),
    ];
    const nights = nightHealth(groupRuns(lines));
    assert.equal(nights.get("2026-08-29").healthy, false);
    assert.equal(streakFromNights(nights).streak, 0);
  });

  it("does not count a run missing one retailer", () => {
    const lines = run("2026-08-28T15:30:04Z", true).slice(0, 4);
    const nights = nightHealth(groupRuns(lines));
    assert.equal(nights.get("2026-08-29").healthy, false);
    assert.equal(streakFromNights(nights).streak, 0);
  });

  it("groups multiple runs on the same NZ night together", () => {
    // Two manual test runs earlier in the day both failed; the scheduled
    // 3:30am run later that UTC day succeeded. NZ date = UTC + 12h, so the
    // 15:30Z run is the next NZ morning.
    const lines = [
      ...run("2026-08-27T06:14:23Z", false),
      ...run("2026-08-27T10:30:04Z", false),
      ...run("2026-08-27T15:30:04Z", true),
    ];
    const nights = nightHealth(groupRuns(lines));
    assert.equal(nights.get("2026-08-27").healthy, false);
    assert.equal(nights.get("2026-08-28").healthy, true);
    assert.equal(streakFromNights(nights).streak, 1);
  });
});
