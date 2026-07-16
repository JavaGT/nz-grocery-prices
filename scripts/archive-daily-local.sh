#!/bin/sh

# Collect every configured retailer into a staged archive, then publish it in
# one rename. This protects the live archive from a partial daily run.
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repo_root=$(CDPATH= cd -- "$script_dir/.." && pwd)
archive_file=${ARCHIVE_FILE:-data/prices.jsonl}

case "$archive_file" in
  /*) ;;
  *) archive_file="$repo_root/$archive_file" ;;
esac

archive_dir=$(dirname -- "$archive_file")
lock_dir="${archive_file}.collect.lock"
stage_file=""

health_file="${COLLECTION_HEALTH_FILE:-${archive_dir}/collection-health.jsonl}"

fail() {
  printf '%s\n' "archive collection failed: $*" >&2
  exit 1
}

cleanup() {
  [ -z "$stage_file" ] || rm -f -- "$stage_file"
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

stage_file=$(mktemp "${archive_file}.tmp.XXXXXX")
if [ -f "$archive_file" ]; then
  cp -- "$archive_file" "$stage_file"
fi

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

run_archive() {
  retailer=$1
  shift
  started_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  line_before=$(wc -l < "$stage_file" 2>/dev/null || echo 0)

  stderr_file=$(mktemp "${stage_file}.err.XXXXXX")

  "$@" 2>"$stderr_file" || {
    status=$?
    ended_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
    printf '%s\n' "archive collection failed: $retailer exited with status $status" >&2
    [ -s "$stderr_file" ] && cat "$stderr_file" >&2

    health_record "$retailer" "$status" 0 "$started_at" "$ended_at" "$stderr_file"
    rm -f "$stderr_file"
    health_finish
    exit "$status"
  }

  ended_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  line_after=$(wc -l < "$stage_file" 2>/dev/null || echo 0)
  records=$((line_after - line_before))
  [ "$records" -lt 0 ] && records=0
  rm -f "$stderr_file"

  health_record "$retailer" 0 "$records" "$started_at" "$ended_at" ""
}

run_archive paknsave "$npm_command" run paknsave -- archive "${PAKNSAVE_STORE:-Royal Oak}" --file "$stage_file"
run_archive woolworths "$npm_command" run woolworths -- archive --file "$stage_file"
run_archive newworld "$npm_command" run newworld -- archive "${NEWWORLD_STORE:-Green Bay}" --file "$stage_file"
run_archive freshchoice "$npm_command" run freshchoice -- archive --file "$stage_file"
run_archive warehouse "$npm_command" run warehouse -- archive --file "$stage_file"

health_finish

# Verify the staged archive before it becomes the archive served to the app.
node -e '
  const fs = require("node:fs");
  const lines = fs.readFileSync(process.argv[1], "utf8").split("\n").filter(Boolean);
  for (const line of lines) JSON.parse(line);
' "$stage_file"

mv -f -- "$stage_file" "$archive_file"
stage_file=""
printf '%s\n' "archive collection completed: $archive_file"
