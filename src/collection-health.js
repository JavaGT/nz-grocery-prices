import { readFileSync } from 'node:fs';

const SECRET_PATTERNS = [
  [/Bearer\s+[a-zA-Z0-9._\-+/=]{8,}/g, 'Bearer **REDACTED**'],
  [/x-auth-token\s*[:=]\s*[^\s;"'&),\]}]{4,}/gi, 'x-auth-token: **REDACTED**'],
  [/authorization\s*[:=]\s*Bearer\s+[a-zA-Z0-9._\-+/=]{8,}/gi, 'authorization: Bearer **REDACTED**'],
  [/session[_-]?id\s*[:=]\s*[^\s;"'&),\]}]{4,}/gi, 'session-id: **REDACTED**'],
  [/(?:(?:^|[\s;"'([{,])(cookie|token|secret|api[_-]?key|password|auth))\s*[:=]\s*["']?[^\s;"'&),\]}]{4,}/gi, '$1=**REDACTED**'],
];

export function sanitizeErrorMessage(text) {
  if (!text) return '';
  let result = String(text);
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    result = result.replace(pattern, replacement);
  }
  return result.slice(0, 1000);
}

export function classifyResult(exitCode, stderr) {
  if (exitCode === 0) return 'success';
  if (exitCode > 128) return 'timeout';

  const s = (stderr || '').toLowerCase();
  if (s.includes('timeouterror') || s.includes('timed out') || s.includes('abortederror')) return 'timeout';
  if (s.includes('abortsignal') || s.includes('signal: "sigterm"') || s.includes('signal: "sigkill"')) return 'timeout';
  if (s.includes('429') || s.includes('too many requests')) return 'rate_limited';
  if (s.includes('502') || s.includes('503') || s.includes('504')) return 'server_error';
  if (s.includes('econnrefused') || s.includes('etimedout') || s.includes('enotfound') || s.includes('econnreset')) return 'network';
  return 'failure';
}

export function buildRecord({ retailer, startTime, endTime, exitCode, records, stderr }) {
  const errorMessage = stderr ? sanitizeErrorMessage(stderr).slice(0, 500) : '';
  const ts = endTime || new Date().toISOString();
  const startedMs = startTime ? new Date(startTime).getTime() : 0;
  const endedMs = endTime ? new Date(endTime).getTime() : 0;

  return {
    ts,
    retailer,
    startedAt: startTime,
    endedAt: endTime,
    durationMs: startedMs && endedMs ? endedMs - startedMs : 0,
    status: exitCode === 0 ? 'success' : 'failure',
    records: typeof records === 'number' ? records : 0,
    exitCode,
    errorCategory: exitCode === 0 ? '' : classifyResult(exitCode, stderr),
    errorMessage,
  };
}

export function parseHealthFile(filePath) {
  const text = readFileSync(filePath, 'utf8');
  const lines = text.split('\n');
  const records = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      records.push(JSON.parse(trimmed));
    } catch {
      break;
    }
  }
  return records;
}

export function retentionTrim(records, maxEntries = 1000) {
  if (records.length <= maxEntries) return records;
  return records.slice(records.length - maxEntries);
}
