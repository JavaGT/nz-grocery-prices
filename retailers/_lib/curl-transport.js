/**
 * curl subprocess transport for campaign clients hitting retailers that
 * fingerprint TLS (Node fetch 403s while curl passes — same rationale as
 * the warehouse adapter's execFile rule in project-map.md).
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const MAX_BUFFER = 20 * 1024 * 1024;

/**
 * GET a URL through curl, returning the body text. `headers` carry any
 * extra request headers; user-agent is passed separately (curl folds it
 * into its own flag set).
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
  const { stdout } = await execFileAsync(
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
    { encoding: "utf8", maxBuffer: MAX_BUFFER },
  );
  return stdout;
}
