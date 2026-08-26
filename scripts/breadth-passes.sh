#!/usr/bin/env bash
#
# Breadth pilot convergence runner: repeated resumable passes until the
# store's catalogue completes, the hang-window lifts, or passes stall.
#
# The Foodstuffs API intermittently hangs (tarpits) whole time-windows
# (see docs/tickets/BREADTH-tickets.md iterations 1–3). Every successful
# page is banked in <archive>.breadth-manifest.json, so passes make
# monotonic progress whenever the window lifts — even if a pass aborts.
#
# Usage:
#   scripts/breadth-passes.sh [--retailer paknsave|newworld|both] \
#     [--delay-ms N] [--max-passes N] [--cooldown-s N] [--file <jsonl>]
#
# Stop conditions per pass:
#   - summary.healthy true          → catalogue complete for the scope: DONE
#   - manifest count unchanged AND  → window fully blocked; keep cooling down
#     circuit opened                   (counted as stalled pass)
#   - --max-passes reached

set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repo_root=$(CDPATH= cd -- "$(dirname -- "$script_dir")" && pwd)

retailer="paknsave"
delay_ms=10000
max_passes=12
cooldown_s=300
archive_file="data/breadth-pilot.jsonl"
extra_args=()

while [ $# -gt 0 ]; do
  case "$1" in
    --retailer)   retailer="$2"; shift 2 ;;
    --delay-ms)   delay_ms="$2"; shift 2 ;;
    --max-passes) max_passes="$2"; shift 2 ;;
    --cooldown-s) cooldown_s="$2"; shift 2 ;;
    --file)       archive_file="$2"; extra_args+=(--file "$2"); shift 2 ;;
    *)            extra_args+=("$1"); shift ;;
  esac
done

manifest_count() {
  node -e '
    const { readFileSync } = require("node:fs");
    try {
      const m = JSON.parse(readFileSync(process.argv[1] + ".breadth-manifest.json", "utf8"));
      console.log(Object.keys(m.completed).length);
    } catch { console.log(0); }
  ' "$1"
}

pass=0
stalled=0
previous_count=-1
while [ "$pass" -lt "$max_passes" ]; do
  pass=$((pass + 1))
  stamp=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  echo "=== pass $pass/$max_passes at ${stamp} ==="

  set +e
  # ${arr[@]+"${arr[@]}"}: macOS bash 3.2 treats empty-array expansion as
  # unbound under set -u; this idiom expands to nothing when empty.
  node "$repo_root/scripts/foodstuffs-breadth.js" \
    --retailer "$retailer" --delay-ms "$delay_ms" \
    ${extra_args[@]+"${extra_args[@]}"} > "/tmp/breadth-pass-$stamp.log" 2>&1
  exit_code=$?
  set -e

  file_arg="${archive_file}"
  count=$(manifest_count "$file_arg")
  echo "pass $pass exit=$exit_code manifest=$count"

  if grep -q '"healthy": true' "/tmp/breadth-pass-$stamp.log"; then
    echo "HEALTHY: catalogue reconciled for scope '$retailer'. Done."
    exit 0
  fi

  if [ "$count" -eq "$previous_count" ]; then
    stalled=$((stalled + 1))
    echo "stalled passes: $stalled (window likely still tarpitted)"
  else
    stalled=0
    echo "progress: $previous_count → $count checkpointed pages"
  fi
  previous_count="$count"

  # Ten consecutive fully-stalled passes (~an hour of blocked window):
  # surface loudly rather than spinning silently.
  if [ "$stalled" -ge 10 ]; then
    echo "GIVING UP: $stalled passes without progress. Try another window."
    exit 2
  fi

  echo "cooling down ${cooldown_s}s before next pass…"
  sleep "$cooldown_s"
done

echo "Reached --max-passes=$max_passes without full reconciliation."
echo "Progress so far is banked in the manifest; re-run this script later."
exit 1
