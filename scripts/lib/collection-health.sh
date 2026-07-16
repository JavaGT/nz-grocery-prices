# Collection health helpers — POSIX/macOS compatible
# Sourced by archive-daily-local.sh; requires HEALTH_JS_PATH to be set.

: "${HEALTH_JS_PATH:?collection-health: HEALTH_JS_PATH must be set}"

health_init() {
  HEALTH_FILE="$1"
  HEALTH_DIR=$(dirname -- "$HEALTH_FILE")
  mkdir -p -- "$HEALTH_DIR"
  HEALTH_STAGE=$(mktemp "${HEALTH_FILE}.tmp.XXXXXX")
  if [ -f "$HEALTH_FILE" ]; then
    cp -- "$HEALTH_FILE" "$HEALTH_STAGE"
  fi
}

health_record() {
  retailer="$1"
  exit_code="$2"
  records="$3"
  started_at="$4"
  ended_at="$5"
  stderr_file="${6:-}"

  CH_RETAILER="$retailer" \
  CH_EXIT_CODE="$exit_code" \
  CH_RECORDS="$records" \
  CH_STARTED_AT="$started_at" \
  CH_ENDED_AT="$ended_at" \
  CH_STDERR_FILE="$stderr_file" \
  node --input-type=module -e "
    import { buildRecord, sanitizeErrorMessage } from '${HEALTH_JS_PATH}';
    import { readFileSync, existsSync } from 'node:fs';
    const stderrText = (process.env.CH_STDERR_FILE && existsSync(process.env.CH_STDERR_FILE))
      ? readFileSync(process.env.CH_STDERR_FILE, 'utf8') : '';
    const record = buildRecord({
      retailer: process.env.CH_RETAILER,
      startTime: process.env.CH_STARTED_AT,
      endTime: process.env.CH_ENDED_AT,
      exitCode: parseInt(process.env.CH_EXIT_CODE, 10),
      records: parseInt(process.env.CH_RECORDS, 10),
      stderr: stderrText,
    });
    process.stdout.write(JSON.stringify(record) + '\n');
  " >> "$HEALTH_STAGE"
}

health_finish() {
  if [ -z "${HEALTH_STAGE:-}" ] || [ ! -f "$HEALTH_STAGE" ]; then
    return 0
  fi
  max_entries="${COLLECTION_HEALTH_MAX_ENTRIES:-1000}"
  line_count=$(wc -l < "$HEALTH_STAGE" 2>/dev/null || echo 0)
  if [ "$line_count" -gt "$max_entries" ]; then
    trimmed="${HEALTH_STAGE}.trimmed"
    tail -n "$max_entries" "$HEALTH_STAGE" > "$trimmed"
    mv -f -- "$trimmed" "$HEALTH_STAGE"
  fi
  mv -f -- "$HEALTH_STAGE" "$HEALTH_FILE"
  HEALTH_STAGE=""
}

health_cleanup() {
  if [ -n "${HEALTH_STAGE:-}" ] && [ -f "$HEALTH_STAGE" ]; then
    rm -f -- "$HEALTH_STAGE"
  fi
  rm -f -- "${HEALTH_STAGE}.trimmed" 2>/dev/null || true
  HEALTH_STAGE=""
}
