#!/bin/sh
#
# Nightly breadth-pilot run: one full-catalogue crawl per pilot context for
# each retailer into separate pilot archives, then an append-only health line.
#
# Designed for launchd (StartCalendarInterval) — all paths absolute, no
# reliance on shell profiles. Safe to re-run: unchanged prices dedupe in
# each archive. Continuation-page manifests resume across runs where
# supported; the Warehouse walker starts fresh each run (a completed
# offset manifest must not silently stall the lane) and every lane fails
# its health line when a store collects fewer than its minimum expected
# products.
#
# Logs: /tmp/nz-grocery-breadth.log (stdout), .error.log (stderr)

set -u

REPO_ROOT="${BREADTH_REPO_ROOT:-/Users/server/Development/nz-grocery-prices}"
NODE="${BREADTH_NODE:-/opt/homebrew/bin/node}"
HEALTH_LOG="${BREADTH_HEALTH_LOG:-/tmp/nz-grocery-breadth.health.jsonl}"
RUN_LOG="${BREADTH_RUN_LOG:-/tmp/nz-grocery-breadth.log}"
ERROR_LOG="${BREADTH_ERROR_LOG:-/tmp/nz-grocery-breadth.error.log}"
COOLDOWN_S="${BREADTH_COOLDOWN_S:-120}"
LOG_STAMP="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

echo "=== breadth-pilot start ${LOG_STAMP} ===" >> "$RUN_LOG"

summary_line() {
  # Extract the fields that matter from a collector's summary JSON.
  "$NODE" -e '
    let raw = "";
    process.stdin.on("data", (chunk) => { raw += chunk; });
    process.stdin.on("end", () => {
      try {
        const start = raw.indexOf("{");
        const summary = JSON.parse(raw.slice(start));
        const store = summary.stores?.[0] ?? {};
        console.log(
          JSON.stringify({
            healthy: summary.healthy,
            uniqueProducts: store.uniqueProducts ?? summary.uniqueProducts ?? null,
            pagesFetched: store.pagesFetched ?? summary.pagesFetched ?? null,
            httpRequestsAdmitted: summary.httpRequestsAdmitted ?? null,
            requestsMade: summary.requestsMade ?? null,
            observationsRecorded: summary.observationsRecorded ?? null,
            incompleteCoverage: store.incompleteCoverage ?? summary.incompleteCoverage ?? false,
          })
        );
      } catch {
        // Collectors crash without a summary on transient network failures;
        // surface the TAIL of stdout/stderr context passed before the JSON
        // attempt instead of an opaque 'unparseable' marker.
        console.log(JSON.stringify({
          healthy: false,
          error: "no summary",
          detail: raw.trim().split("\n").filter(Boolean).slice(-2).join(" | ").slice(0, 300),
        }));
      }
    });
  '
}

overall=0

run_collector() {
  label="$1"
  file="$2"
  script="$3"
  shift 3

  echo "--- $label $(date -u +%H:%M:%SZ)" >> "$RUN_LOG"
  output="$("$NODE" "$REPO_ROOT/scripts/$script" "$@" --file "$file" 2>>"$ERROR_LOG")"
  code=$?

  result="$(printf '%s' "$output" | summary_line)"
  echo "${LOG_STAMP} ${label} exit=${code} ${result}" >> "$HEALTH_LOG"

  if [ "$code" -ne 0 ]; then
    overall=1
    echo "breadth pilot: $label exited $code" >&2
  fi
}

run_collector paknsave "$REPO_ROOT/data/breadth-pilot.jsonl" \
  foodstuffs-mobile-breadth.js --retailer paknsave --delay-ms 5000
sleep "$COOLDOWN_S"
run_collector newworld "$REPO_ROOT/data/breadth-pilot-nw.jsonl" \
  foodstuffs-mobile-breadth.js --retailer newworld --delay-ms 5000
sleep "$COOLDOWN_S"
run_collector freshchoice "$REPO_ROOT/data/breadth-pilot-fc.jsonl" \
  freshchoice-breadth.js --delay-ms 3000 --budget 800
sleep "$COOLDOWN_S"
run_collector warehouse "$REPO_ROOT/data/breadth-pilot-tw.jsonl" \
  warehouse-breadth.js --delay-ms 3000 --budget 400
sleep "$COOLDOWN_S"
run_collector woolworths "$REPO_ROOT/data/breadth-pilot-ww.jsonl" \
  woolworths-breadth.js --delay-ms 3000 --size 120 --budget 400

# Record the running streak of consecutive healthy nights (gate: 3) in the
# run log — the health log stays strictly machine-parseable.
"$NODE" "$REPO_ROOT/scripts/breadth-pilot-gate.js" \
  --health-log "$HEALTH_LOG" \
  >> "$RUN_LOG" 2>/dev/null \
  || true

echo "=== breadth-pilot done overall=$overall ===" >> "$RUN_LOG"
exit "$overall"
