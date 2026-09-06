/**
 * curl subprocess transport for campaign clients hitting retailers that
 * fingerprint TLS (Node fetch 403s while curl passes — same rationale as
 * the warehouse adapter's execFile rule in project-map.md).
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const MAX_BUFFER = 20 * 1024 * 1024;

/** Bound the stderr / body excerpts embedded in failure errors. */
const FAIL_EXCERPT_CHARS = 200;

/** One-line bounded excerpt for error messages. */
function excerpt(text) {
  const line = String(text ?? "").replace(/\s+/g, " ").trim();
  return line.length > FAIL_EXCERPT_CHARS ? `${line.slice(0, FAIL_EXCERPT_CHARS)}…` : line;
}

/**
 * Wrap an execFile rejection with the details that cost diagnosis time:
 * curl's exit code, bounded stderr, and — because --fail-with-body leaves
 * the failure body (WAF challenge, error JSON) in stdout — a bounded body
 * prefix. The original error rides along as `cause`.
 */
function curlFailureError(url, error) {
  const code = typeof error.code === "number" ? `exit ${error.code}` : (error.code ?? "failed");
  const parts = [`curl GET ${url} ${code}`];
  const stderr = excerpt(error.stderr);
  if (stderr) parts.push(`stderr: ${stderr}`);
  const body = excerpt(error.stdout);
  if (body) parts.push(`body starts: ${body}`);
  return new Error(parts.join(" — "), { cause: error });
}

/**
 * GET a URL through curl, returning the body text. `headers` carry any
 * extra request headers; user-agent is passed separately (curl folds it
 * into its own flag set). Failures throw an error naming the URL, curl's
 * exit code, and bounded stderr/body excerpts; the execFile-level timeout
 * (max-time + 2s grace) is a wedge-guard so the promise cannot outlive
 * curl's own `--max-time`.
 */
export async function curlGetText(url, {
  headers = {},
  userAgent,
  curlPath = "curl",
  timeoutMs = 30000,
} = {}) {
  const headerArguments = Object.entries(headers)
    .filter(([name]) => name.toLocaleLowerCase("en-NZ") !== "user-agent")
    .flatMap(([name, value]) => ["--header", `${name}: ${value}`]);
  let stdout;
  try {
    ({ stdout } = await execFileAsync(
      curlPath,
      [
        "--silent",
        "--show-error",
        "--fail-with-body",
        "--location",
        "--compressed",
        "--max-time",
        String(Math.ceil(timeoutMs / 1000)),
        ...(userAgent ? ["--user-agent", userAgent] : []),
        ...headerArguments,
        url,
      ],
      { encoding: "utf8", maxBuffer: MAX_BUFFER, timeout: timeoutMs + 2000 },
    ));
  } catch (error) {
    throw curlFailureError(url, error);
  }
  return stdout;
}
