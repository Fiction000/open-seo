import { stripVTControlCharacters } from "node:util";

const SAFE_MESSAGES = new Set([
  "Authentication error",
  "Unauthorized to access requested resource",
  "Invalid access token",
  "Invalid API Token",
  "Invalid request",
  "Method not allowed",
  "Worker not found",
  "Rate limit exceeded",
]);

export function wranglerDiagnosticEnv(env) {
  return {
    ...env,
    WRANGLER_LOG: "debug",
    WRANGLER_LOG_SANITIZE: "true",
    WRANGLER_WRITE_LOGS: "false",
    WRANGLER_SEND_ERROR_REPORTS: "false",
  };
}

export function wranglerFailure(error) {
  const stderr = stripVTControlCharacters(error?.stderr ?? "");
  const stdout = stripVTControlCharacters(error?.stdout ?? "");
  const primary = stderr.match(
    /A request to the Cloudflare API \(([^\r\n)]+)\) failed\.([\s\S]*?)(?=\[ERROR\]|APIError:|$)/,
  );
  const note = primary?.[2].match(
    /(?:^|\n)\s*([^\[]*?)\s*\[code: (\d{1,9})\](?=\s|$)/,
  );
  const message = note?.[1].replace(/\s+/g, " ").trim();
  let status = "unknown";
  let requestPath;
  for (const line of stdout.split("\n")) {
    const request = line.match(/^-- START CF API REQUEST: [A-Z]+ (\S+)$/);
    if (request) {
      try {
        requestPath = new URL(request[1]).pathname;
      } catch {
        requestPath = undefined;
      }
    }
    const response = line.match(/^-- START CF API RESPONSE: .*?\b([1-5]\d\d)$/);
    if (
      primary &&
      response &&
      (requestPath === primary[1] || requestPath === `/client/v4${primary[1]}`)
    )
      status = response[1];
  }
  const exit =
    Number.isInteger(error?.code) && error.code >= 0 && error.code <= 255
      ? error.code
      : "unknown";
  return `exit=${exit}; HTTP=${status}; API code=${note?.[2] ?? "unknown"}; message=${JSON.stringify(SAFE_MESSAGES.has(message) ? message : "suppressed (not allowlisted)")}`;
}
