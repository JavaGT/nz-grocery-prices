import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  sanitizeErrorMessage,
  classifyResult,
  buildRecord,
  parseHealthFile,
  retentionTrim,
} from "../src/collection-health.js";

describe("sanitizeErrorMessage", () => {
  it("redacts Bearer tokens", () => {
    const input = "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTYifQ.something";
    const result = sanitizeErrorMessage(input);
    assert.doesNotMatch(result, /eyJhbGci/);
    assert.match(result, /Bearer \*\*REDACTED\*\*/);
  });

  it("redacts cookie values", () => {
    const input = 'Error: cookie="mysecretcookievalue"; path=/';
    const result = sanitizeErrorMessage(input);
    assert.doesNotMatch(result, /mysecretcookievalue/);
    assert.match(result, /\*\*REDACTED\*\*/);
  });

  it("redacts token values", () => {
    const input = "invalid token: abc123def456tokenvalue";
    const result = sanitizeErrorMessage(input);
    assert.doesNotMatch(result, /abc123def456tokenvalue/);
    assert.match(result, /\*\*REDACTED\*\*/);
  });

  it("redacts api_key and api-key patterns", () => {
    const input = 'api_key = "sk-1234567890abcdef"';
    const result = sanitizeErrorMessage(input);
    assert.doesNotMatch(result, /sk-1234567890abcdef/);
  });

  it("redacts password values", () => {
    const input = "password=hunter2,details=rest";
    const result = sanitizeErrorMessage(input);
    assert.doesNotMatch(result, /hunter2/);
  });

  it("returns empty string for null/undefined/empty", () => {
    assert.equal(sanitizeErrorMessage(null), "");
    assert.equal(sanitizeErrorMessage(undefined), "");
    assert.equal(sanitizeErrorMessage(""), "");
  });

  it("does not alter safe messages", () => {
    const input = "Product not found for ID 12345";
    assert.equal(sanitizeErrorMessage(input), input);
  });

  it("truncates long messages to 1000 chars", () => {
    const input = "x".repeat(2000);
    assert.equal(sanitizeErrorMessage(input).length, 1000);
  });

  it("redacts session_id and session-id", () => {
    const input = "session_id=abc123def456; session-id=xyz789";
    const result = sanitizeErrorMessage(input);
    assert.doesNotMatch(result, /abc123def456/);
    assert.doesNotMatch(result, /xyz789/);
  });
});

describe("classifyResult", () => {
  it("returns success for exitCode 0", () => {
    assert.equal(classifyResult(0, ""), "success");
  });

  it("returns timeout for exit codes > 128", () => {
    assert.equal(classifyResult(137, ""), "timeout");
    assert.equal(classifyResult(143, ""), "timeout");
  });

  it("returns timeout for TimeoutError in stderr", () => {
    assert.equal(classifyResult(1, "TimeoutError: request timed out"), "timeout");
    assert.equal(classifyResult(1, "AbortedError: aborted"), "timeout");
  });

  it("returns rate_limited for 429 in stderr", () => {
    assert.equal(classifyResult(1, "HTTP 429 Too Many Requests"), "rate_limited");
  });

  it("returns server_error for 5xx in stderr", () => {
    assert.equal(classifyResult(1, "HTTP 502 Bad Gateway"), "server_error");
    assert.equal(classifyResult(1, "503 Service Unavailable"), "server_error");
  });

  it("returns network for connection errors", () => {
    assert.equal(classifyResult(1, "ECONNREFUSED"), "network");
    assert.equal(classifyResult(1, "ETIMEDOUT"), "network");
    assert.equal(classifyResult(1, "ENOTFOUND"), "network");
  });

  it("returns failure for plain exit code", () => {
    assert.equal(classifyResult(17, ""), "failure");
    assert.equal(classifyResult(1, "Something went wrong"), "failure");
  });
});

describe("buildRecord", () => {
  it("builds a success record correctly", () => {
    const record = buildRecord({
      retailer: "paknsave",
      startTime: "2026-07-16T10:00:00.000Z",
      endTime: "2026-07-16T10:00:05.123Z",
      exitCode: 0,
      records: 42,
      stderr: "",
    });
    assert.equal(record.retailer, "paknsave");
    assert.equal(record.status, "success");
    assert.equal(record.exitCode, 0);
    assert.equal(record.records, 42);
    assert.equal(record.durationMs, 5123);
    assert.equal(record.errorCategory, "");
    assert.equal(record.errorMessage, "");
    assert.ok(record.ts);
    assert.ok(record.startedAt);
    assert.ok(record.endedAt);
  });

  it("builds a failure record with classification", () => {
    const record = buildRecord({
      retailer: "newworld",
      startTime: "2026-07-16T10:00:10.000Z",
      endTime: "2026-07-16T10:00:15.000Z",
      exitCode: 1,
      records: 0,
      stderr: "Error: Connection refused: ECONNREFUSED",
    });
    assert.equal(record.retailer, "newworld");
    assert.equal(record.status, "failure");
    assert.equal(record.exitCode, 1);
    assert.equal(record.records, 0);
    assert.equal(record.errorCategory, "network");
    assert.match(record.errorMessage, /Connection refused/);
  });

  it("sanitizes stderr in error message", () => {
    const record = buildRecord({
      retailer: "woolworths",
      startTime: "2026-07-16T10:00:00.000Z",
      endTime: "2026-07-16T10:00:05.000Z",
      exitCode: 1,
      records: 0,
      stderr: "token=abc123\nError: timeout",
    });
    assert.doesNotMatch(record.errorMessage, /abc123/);
    assert.match(record.errorMessage, /\*\*REDACTED\*\*/);
  });

  it("defaults records to 0 when absent", () => {
    const record = buildRecord({
      retailer: "test",
      startTime: "2026-07-16T10:00:00.000Z",
      endTime: "2026-07-16T10:00:01.000Z",
      exitCode: 0,
    });
    assert.equal(record.records, 0);
  });
});

describe("parseHealthFile", () => {
  it("parses valid health records", () => {
    const file = join(tmpdir(), "ch-test-valid.jsonl");
    writeFileSync(file, '{"retailer":"a"}\n{"retailer":"b"}\n');
    const records = parseHealthFile(file);
    assert.equal(records.length, 2);
    assert.equal(records[0].retailer, "a");
    assert.equal(records[1].retailer, "b");
  });

  it("ignores truncated final line", () => {
    const file = join(tmpdir(), "ch-test-truncated.jsonl");
    writeFileSync(file, '{"retailer":"a"}\n{"retailer":"b"}\n{"retailer');
    const records = parseHealthFile(file);
    assert.equal(records.length, 2);
  });

  it("works with single trailing newline", () => {
    const file = join(tmpdir(), "ch-test-trailing.jsonl");
    writeFileSync(file, '{"retailer":"a"}\n');
    const records = parseHealthFile(file);
    assert.equal(records.length, 1);
  });

  it("returns empty array for empty file", () => {
    const file = join(tmpdir(), "ch-test-empty.jsonl");
    writeFileSync(file, "");
    const records = parseHealthFile(file);
    assert.deepEqual(records, []);
  });
});

describe("retentionTrim", () => {
  it("returns the same array when under limit", () => {
    const arr = [1, 2, 3];
    assert.deepEqual(retentionTrim(arr, 5), arr);
  });

  it("returns last N entries when over limit", () => {
    const arr = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const result = retentionTrim(arr, 3);
    assert.deepEqual(result, [8, 9, 10]);
  });
});
