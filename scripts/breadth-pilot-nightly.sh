#!/bin/sh
#
# Nightly breadth-pilot run: one full-catalogue crawl per pilot store into
# the pilot archives, then an append-only health line summarizing the night.
#
# Designed for launchd (StartCalendarInterval) — all paths absolute, no
# reliance on shell profiles. Safe to re-run: both collectors resume from
# their manifests, and unchanged prices dedupe in the archive.
#
# Logs: /tmp/nz-grocery-breadth.log (stdout), .error.log (stderr)

set -u

REPO_ROOT="/Users/server/Development/nz-grocery-prices"
NODE="/opt/homebrew/bin/node"
LOG_STAMP="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

echo "=== breadth-pilot start ${LOG_STAMP} ===" >> /tmp/nz-grocery-breadth.log

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
            uniqueProducts: store.uniqueProducts ?? null,
            pagesFetched: store.pagesFetched ?? null,
            httpRequestsAdmitted: summary.httpRequestsAdmitted ?? null,
            observationsRecorded: summary.observationsRecorded ?? null,
            incompleteCoverage: store.incompleteCoverage ?? false,
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

for retailer in paknsave newworld; do
  case "$retailer" in
    paknsave) file="data/breadth-pilot.jsonl" ;;
    newworld) file="data/breadth-pilot-nw.jsonl" ;;
  esac

  echo "--- $retailer $(date -u +%H:%M:%SZ)" >> /tmp/nz-grocery-breadth.log

  output="$("$NODE" "$REPO_ROOT/scripts/foodstuffs-mobile-breadth.js" \
    --retailer "$retailer" --delay-ms 5000 --file "$file" 2>>/tmp/nz-grocery-breadth.error.log)"
  code=$?

  result="$(printf '%s' "$output" | summary_line)"
  echo "${LOG_STAMP} ${retailer} exit=${code} ${result}" >> /tmp/nz-grocery-breadth.health.jsonl

  if [ "$code" -ne 0 ]; then
    overall=1
    echo "breadth pilot: $retailer exited $code" >&2
  fi

  # Cool-down between banners so requests never span hosts back-to-back.
  [ "$retailer" = "paknsave" ] && sleep 120
done

# Record the running streak of consecutive healthy nights (gate: 3) in the
# run log — the health log stays strictly machine-parseable.
"$NODE" "$REPO_ROOT/scripts/breadth-pilot-gate.js" \
  >> /tmp/nz-grocery-breadth.log 2>/dev/null \
  || true

echo "=== breadth-pilot done overall=$overall ===" >> /tmp/nz-grocery-breadth.log
exit "$overall"
