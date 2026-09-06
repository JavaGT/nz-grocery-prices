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
# Lanes run in PARALLEL across distinct retailer hosts (BREADTH-9): each
# lane writes its own archive under its own lock and paces its own host,
# so overlap adds no per-host load and the night ends at the slowest lane
# instead of the sum of all lanes. Exception: paknsave + newworld share one
# Foodstuffs mobile API host with tarpit history, so that pair stays serial
# inside its lane with the inter-banner cooldown.
#
# Logs: data/logs/nz-grocery-breadth.log (run log), .error.log (collector
# stderr), nz-grocery-breadth.health.jsonl (machine-parsed health lines).
# The daemon plist's own stdout/stderr stay in /tmp until its next reinstall
# (see ops/nz.grocery-prices.breadth.daemon.plist.template). Lanes interleave
# in the human-readable run log; the machine-parsed health log stays one
# JSON object per line (small single appends). An unhealthy lane also gets
# its full summary JSON appended to the run log for forensics — the health
# line deliberately caps warnings to stay one line.

set -u

REPO_ROOT="${BREADTH_REPO_ROOT:-/Users/server/Development/nz-grocery-prices}"
NODE="${BREADTH_NODE:-/opt/homebrew/bin/node}"
LOG_DIR="${BREADTH_LOG_DIR:-$REPO_ROOT/data/logs}"
mkdir -p "$LOG_DIR"
HEALTH_LOG="${BREADTH_HEALTH_LOG:-$LOG_DIR/nz-grocery-breadth.health.jsonl}"
RUN_LOG="${BREADTH_RUN_LOG:-$LOG_DIR/nz-grocery-breadth.log}"
ERROR_LOG="${BREADTH_ERROR_LOG:-$LOG_DIR/nz-grocery-breadth.error.log}"
COOLDOWN_S="${BREADTH_COOLDOWN_S:-120}"
# BREADTH-14 trial (7 nights from 2026-09-05): 3000ms vs the script's 5000ms
# default. Watch circuit-breaker/incompleteCoverage health lines; revert by
# setting BREADTH_FS_DELAY_MS=5000 if the shared host tarpits.
FS_DELAY_MS="${BREADTH_FS_DELAY_MS:-3000}"
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
            error: store.error ?? null,
            budgetExhausted: store.budgetExhausted ?? false,
            seededDiscovery: store.seededDiscovery ?? null,
            skippedDiscovery: store.skippedDiscovery ?? null,
            treeNodes: store.treeNodes ?? null,
            warnings: (store.warnings ?? [])
              .slice(0, 2)
              .map((w) => String(w).slice(0, 140)),
          })
        );
      } catch {
        // Collectors crash without a summary on transient network failures;
        // surface the TAIL of stdout/stderr context passed before the JSON
        // attempt instead of an opaque unparseable marker.
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

  # Forensics: an unhealthy lane's full summary (all warnings, incomplete
  # nodes, discovery counts) goes to the human-readable run log — the health
  # line caps warnings to stay machine-parseable on one line.
  case "$result" in
    *'"healthy":false'*)
      {
        echo "---- $label full summary ${LOG_STAMP} ----"
        printf '%s' "$output" | "$NODE" -e '
          let raw = "";
          process.stdin.on("data", (chunk) => { raw += chunk; });
          process.stdin.on("end", () => {
            const start = raw.indexOf("{");
            try {
              const summary = JSON.parse(raw.slice(start));
              console.log(JSON.stringify(summary, null, 1).slice(0, 8000));
            } catch {
              console.log(raw.trim().slice(-2000));
            }
          });
        '
      } >> "$RUN_LOG" 2>/dev/null || true
      ;;
  esac

  if [ "$code" -ne 0 ]; then
    echo "breadth pilot: $label exited $code" >&2
  fi
  return "$code"
}

# One background lane per distinct retailer host. Each collector paces its
# own host, so overlapping lanes never raises any host's request rate, and
# the night ends at the slowest lane instead of the sum of all lanes.
# Exception: paknsave + newworld share one Foodstuffs mobile API host with
# tarpit history, so that pair stays serial inside one lane with the
# inter-banner cooldown between them.

run_foodstuffs_lane() {
  lane=0
  run_collector paknsave "$REPO_ROOT/data/breadth-pilot.jsonl" \
    foodstuffs-mobile-breadth.js --retailer paknsave --delay-ms "$FS_DELAY_MS" || lane=1
  sleep "$COOLDOWN_S"
  run_collector newworld "$REPO_ROOT/data/breadth-pilot-nw.jsonl" \
    foodstuffs-mobile-breadth.js --retailer newworld --delay-ms "$FS_DELAY_MS" || lane=1
  return "$lane"
}

run_foodstuffs_lane & foodstuffs_lane=$!
run_collector freshchoice "$REPO_ROOT/data/breadth-pilot-fc.jsonl" \
  freshchoice-breadth.js --delay-ms 3000 --budget 1200 & freshchoice_lane=$!
run_collector warehouse "$REPO_ROOT/data/breadth-pilot-tw.jsonl" \
  warehouse-breadth.js --delay-ms 3000 --budget 400 & warehouse_lane=$!
run_collector woolworths "$REPO_ROOT/data/breadth-pilot-ww.jsonl" \
  woolworths-breadth.js --delay-ms 3000 --size 120 --budget 400 & woolworths_lane=$!

wait "$foodstuffs_lane" || overall=1
wait "$freshchoice_lane" || overall=1
wait "$warehouse_lane" || overall=1
wait "$woolworths_lane" || overall=1

# Record the running streak of consecutive healthy nights (gate: 3) in the
# run log — the health log stays strictly machine-parseable.
"$NODE" "$REPO_ROOT/scripts/breadth-pilot-gate.js" \
  --health-log "$HEALTH_LOG" \
  >> "$RUN_LOG" 2>/dev/null \
  || true

echo "=== breadth-pilot done overall=$overall ===" >> "$RUN_LOG"
exit "$overall"
