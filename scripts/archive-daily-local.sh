#!/bin/sh

# Collect every configured retailer straight into ARCHIVE_FILE (default
# data/archive.db). SQLite WAL lets the live site keep reading while we write.
# No staging copy: a mid-run crash keeps every store already recorded.
#
# Per-store skip: collectors pass --max-age-hours (default 12) so stores
# observed inside that window are not re-hit. Set MAX_AGE_HOURS=0 to force all.
#
# Legacy JSONL still works if ARCHIVE_FILE ends in .jsonl (no age skip there).
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repo_root=$(CDPATH= cd -- "$script_dir/.." && pwd)
archive_file=${ARCHIVE_FILE:-data/archive.db}

case "$archive_file" in
  /*) ;;
  *) archive_file="$repo_root/$archive_file" ;;
esac

archive_dir=$(dirname -- "$archive_file")
lock_dir="${archive_file}.collect.lock"

health_file="${COLLECTION_HEALTH_FILE:-${archive_dir}/collection-health.jsonl}"
max_age_hours=${MAX_AGE_HOURS:-12}

is_sqlite_archive() {
  case "$1" in
    *.db|*.sqlite|*.sqlite3) return 0 ;;
    *) return 1 ;;
  esac
}

fail() {
  printf '%s\n' "archive collection failed: $*" >&2
  exit 1
}

cleanup() {
  rmdir -- "$lock_dir" 2>/dev/null || true
}

mkdir -p -- "$archive_dir"
if ! mkdir -- "$lock_dir" 2>/dev/null; then
  fail "another collection appears to be running ($lock_dir)"
fi

HEALTH_JS_PATH="$repo_root/src/collection-health.js"
# shellcheck source=scripts/lib/collection-health.sh
. "$script_dir/lib/collection-health.sh"
health_init "$health_file"
trap 'health_finish 2>/dev/null; health_cleanup; cleanup' 0 HUP INT TERM

# The plist can point to a mode-600 file containing KEY=value settings such as
# WOOLWORTHS_COOKIE, FRESHCHOICE_ORIGIN, and FRESHCHOICE_STORE_NAME. Keep the
# values out of the plist and do not echo this file.
if [ -n "${COLLECTOR_ENV_FILE:-}" ]; then
  [ -r "$COLLECTOR_ENV_FILE" ] || fail "COLLECTOR_ENV_FILE is not readable"
  set -a
  # shellcheck disable=SC1090
  . "$COLLECTOR_ENV_FILE"
  set +a
fi

npm_command=${NPM_COMMAND:-npm}
cd -- "$repo_root"

# One retailer failing must not discard the others (or abort mid multi-store).
collection_failures=0

max_age_args=
if [ -n "${max_age_hours}" ]; then
  max_age_args="--max-age-hours $max_age_hours"
fi

run_archive() {
  retailer=$1
  shift
  started_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  if is_sqlite_archive "$archive_file"; then
    size_before=$(wc -c < "$archive_file" 2>/dev/null || echo 0)
  else
    line_before=$(wc -l < "$archive_file" 2>/dev/null || echo 0)
  fi

  stderr_file=$(mktemp "${archive_dir}/.collect.err.XXXXXX")

  # Capture the collector's real exit code. `if ! cmd` would set $? to the
  # negation's status (always 0), masking every failure as a success.
  if "$@" 2>"$stderr_file"; then
    status=0
  else
    status=$?
  fi
  if [ "$status" -ne 0 ]; then
    ended_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
    printf '%s\n' "archive collection failed: $retailer exited with status $status (continuing)" >&2
    [ -s "$stderr_file" ] && cat "$stderr_file" >&2

    health_record "$retailer" "$status" 0 "$started_at" "$ended_at" "$stderr_file"
    rm -f "$stderr_file"
    collection_failures=$((collection_failures + 1))
    return 0
  fi

  ended_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  if is_sqlite_archive "$archive_file"; then
    size_after=$(wc -c < "$archive_file" 2>/dev/null || echo 0)
    records=$((size_after - size_before))
    [ "$records" -lt 0 ] && records=0
  else
    line_after=$(wc -l < "$archive_file" 2>/dev/null || echo 0)
    records=$((line_after - line_before))
    [ "$records" -lt 0 ] && records=0
  fi
  rm -f "$stderr_file"

  health_record "$retailer" 0 "$records" "$started_at" "$ended_at" ""
}

# Multi-store retailers default to every store. Set *_STORE (or
# FRESHCHOICE_ORIGIN) to pin a single store. *_DELAY_MS controls the pause
# between stores in all-stores mode (default 1000).
#
# Warehouse is national-online only (no per-store prices).

if [ -n "${PAKNSAVE_STORE:-}" ]; then
  # shellcheck disable=SC2086
  run_archive paknsave "$npm_command" run paknsave -- archive "$PAKNSAVE_STORE" --file "$archive_file" $max_age_args
else
  delay_args=
  if [ -n "${PAKNSAVE_DELAY_MS:-}" ]; then
    delay_args="--delay-ms $PAKNSAVE_DELAY_MS"
  fi
  # shellcheck disable=SC2086
  run_archive paknsave "$npm_command" run paknsave -- archive --all-stores $delay_args $max_age_args --file "$archive_file"
fi

if [ -n "${WOOLWORTHS_STORE:-}" ]; then
  # shellcheck disable=SC2086
  run_archive woolworths "$npm_command" run woolworths -- archive --store "$WOOLWORTHS_STORE" --file "$archive_file" $max_age_args
else
  delay_args=
  if [ -n "${WOOLWORTHS_DELAY_MS:-}" ]; then
    delay_args="--delay-ms $WOOLWORTHS_DELAY_MS"
  fi
  # shellcheck disable=SC2086
  run_archive woolworths "$npm_command" run woolworths -- archive --all-stores $delay_args $max_age_args --file "$archive_file"
fi

if [ -n "${NEWWORLD_STORE:-}" ]; then
  # shellcheck disable=SC2086
  run_archive newworld "$npm_command" run newworld -- archive "$NEWWORLD_STORE" --file "$archive_file" $max_age_args
else
  delay_args=
  if [ -n "${NEWWORLD_DELAY_MS:-}" ]; then
    delay_args="--delay-ms $NEWWORLD_DELAY_MS"
  fi
  # shellcheck disable=SC2086
  run_archive newworld "$npm_command" run newworld -- archive --all-stores $delay_args $max_age_args --file "$archive_file"
fi

if [ -n "${FRESHCHOICE_ORIGIN:-}" ] || [ -n "${FRESHCHOICE_STORE:-}" ]; then
  if [ -n "${FRESHCHOICE_ORIGIN:-}" ]; then
    # shellcheck disable=SC2086
    run_archive freshchoice "$npm_command" run freshchoice -- archive --origin "$FRESHCHOICE_ORIGIN" --file "$archive_file" $max_age_args
  else
    # shellcheck disable=SC2086
    run_archive freshchoice "$npm_command" run freshchoice -- archive --origin "https://${FRESHCHOICE_STORE}.store.freshchoice.co.nz" --file "$archive_file" $max_age_args
  fi
else
  delay_args=
  if [ -n "${FRESHCHOICE_DELAY_MS:-}" ]; then
    delay_args="--delay-ms $FRESHCHOICE_DELAY_MS"
  fi
  # shellcheck disable=SC2086
  run_archive freshchoice "$npm_command" run freshchoice -- archive --all-stores $delay_args $max_age_args --file "$archive_file"
fi

run_archive warehouse "$npm_command" run warehouse -- archive --file "$archive_file"

health_finish

# Checkpoint WAL so readers see a compact main file (site keeps working either way).
if is_sqlite_archive "$archive_file" && [ -f "$archive_file" ]; then
  node -e '
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(process.argv[1]);
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    db.close();
  ' "$archive_file" || true
fi

if [ "$collection_failures" -gt 0 ]; then
  printf '%s\n' "archive collection completed with $collection_failures retailer failure(s): $archive_file"
else
  printf '%s\n' "archive collection completed: $archive_file"
fi
