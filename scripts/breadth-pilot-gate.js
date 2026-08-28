#!/usr/bin/env node
//
// Breadth-pilot night gate: how many CONSECUTIVE healthy nights has the
// nightly pilot run logged so far?
//
// Reads the append-only health log written by breadth-pilot-nightly.sh
// (one line per retailer per run: "<LOG_STAMP> <retailer> exit=<code> {json}").
// A run is healthy when EVERY retailer line for that run has exit=0 and a
// JSON summary with healthy:true. A "night" is the NZST calendar date the
// run belongs to; the streak counts consecutive healthy nights backward
// from the most recent run.
//
// Usage:
//   node scripts/breadth-pilot-gate.js [--health-log <path>] [--target N]
//   env: BREADTH_HEALTH_LOG (default /tmp/nz-grocery-breadth.health.jsonl)
//        BREADTH_TZ_OFFSET_H (NZST offset from UTC; default 12)
//
// Exit code 0 when streak >= target (default 3); 1 otherwise. This lets it
// double as an alerting probe.

import { readFileSync, existsSync } from "node:fs";

const DEFAULT_LOG = "/tmp/nz-grocery-breadth.health.jsonl";
const DEFAULT_TARGET = 3;
const TZ_OFFSET_H = Number(process.env.BREADTH_TZ_OFFSET_H ?? 12);

export function parseArgs(argv) {
  const out = { log: DEFAULT_LOG, target: DEFAULT_TARGET };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--health-log") out.log = argv[++i];
    else if (arg === "--target") out.target = Number(argv[++i]);
  }
  return out;
}

/** Parse one health-log line → {stamp, retailer, exit, summary} or null. */
export function parseLine(line) {
  const trimmed = line.trim();
  if (!trimmed) return null;
  const space = trimmed.indexOf(" ");
  if (space < 0) return null;
  const stamp = trimmed.slice(0, space);
  const rest = trimmed.slice(space + 1);
  const exitMatch = rest.match(/^(\S+)\s+exit=(\d+)\s+(.+)$/);
  if (!exitMatch) return null;
  let summary = null;
  try {
    const start = rest.indexOf("{");
    summary = JSON.parse(rest.slice(start));
  } catch {
    // Unparseable summary (collector crashed without one) → unhealthy.
  }
  return {
    stamp,
    retailer: exitMatch[1],
    exit: Number(exitMatch[2]),
    summary,
    healthy: exitMatch[2] === "0" && summary !== null && summary.healthy === true,
  };
}

/** Group parsed lines into runs keyed by their timestamp. */
export function groupRuns(lines) {
  const runs = new Map();
  for (const line of lines) {
    const entry = parseLine(line);
    if (!entry) continue;
    if (!runs.has(entry.stamp)) runs.set(entry.stamp, []);
    runs.get(entry.stamp).push(entry);
  }
  return runs;
}

/** NZST date (YYYY-MM-DD) for a UTC ISO stamp, given the TZ offset in hours. */
export function nzDate(stamp, offsetHours = TZ_OFFSET_H) {
  const ms = Date.parse(stamp);
  if (Number.isNaN(ms)) return null;
  return new Date(ms + offsetHours * 3600 * 1000).toISOString().slice(0, 10);
}

/**
 * Per-night health: date → { healthy, anyRun }. A night is healthy when at
 * least one fully-healthy run happened on that NZST date.
 */
export function nightHealth(runs, offsetHours = TZ_OFFSET_H) {
  const nights = new Map();
  for (const entries of runs.values()) {
    const stamp = entries[0].stamp;
    const date = nzDate(stamp, offsetHours);
    if (!date) continue;
    if (!nights.has(date)) nights.set(date, { healthy: false, anyRun: false });
    const night = nights.get(date);
    night.anyRun = true;
    if (entries.length > 0 && entries.every((e) => e.healthy)) night.healthy = true;
  }
  return nights;
}

/**
 * Consecutive healthy nights counting back from the most recent night that
 * has a run. Returns { streak, healthyDates, lastDate, missingSince }.
 * missingSince: the first (oldest) date in the streak run; null if the most
 * recent night itself was unhealthy.
 */
export function streakFromNights(nights) {
  const dates = [...nights.keys()].sort().reverse();
  if (dates.length === 0) return { streak: 0, healthyDates: [], lastDate: null, missingSince: null };
  const streak = [];
  let streakBroken = false;
  for (const date of dates) {
    if (streakBroken) break;
    const night = nights.get(date);
    if (night.healthy) streak.push(date);
    else streakBroken = true;
  }
  return {
    streak: streak.length,
    healthyDates: streak,
    lastDate: dates[0],
    missingSince: streakBroken && streak.length > 0 ? dates[streak.length] : null,
  };
}

export function main() {
  const { log, target } = parseArgs(process.argv.slice(2));
  const text = existsSync(log) ? readFileSync(log, "utf8") : "";
  const runs = groupRuns(text.split("\n"));
  const nights = nightHealth(runs);
  const { streak, healthyDates, lastDate, missingSince } = streakFromNights(nights);

  console.log(`streak=${streak}/${target} lastNight=${lastDate ?? "none"}`);
  if (healthyDates.length > 0) {
    console.log(`healthy nights (newest first): ${healthyDates.join(", ")}`);
  }
  if (missingSince) {
    console.log(`streak ends: night ${missingSince} was not fully healthy`);
  }
  return streak >= target ? 0 : 1;
}

// Run directly (not when imported by tests).
if (process.argv[1]?.endsWith("breadth-pilot-gate.js")) {
  process.exitCode = main();
}
