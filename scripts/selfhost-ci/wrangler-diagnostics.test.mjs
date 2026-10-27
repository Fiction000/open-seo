import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  wranglerFailure,
  wranglerDiagnosticEnv,
} from "./wrangler-diagnostics.mjs";

const path =
  "/accounts/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/workers/services/private-worker";
const request = (url, status) =>
  `-- START CF API REQUEST: GET https://api.cloudflare.com/client/v4${url}\n-- END CF API REQUEST\n-- START CF API RESPONSE: Forbidden ${status}\n-- END CF API RESPONSE\n`;
const stderr = (message, code) =>
  `✘ [ERROR] A request to the Cloudflare API (${path}) failed.\n\n  ${message} [code: ${code}]\n`;

test("primary API diagnostic pairs HTTP status and code before whoami errors", () => {
  assert.equal(
    wranglerFailure({
      code: 1,
      stdout: request(path, 403) + request("/user/tokens/verify", 401),
      stderr:
        stderr("Authentication error", 10000) +
        "✘ [ERROR] A request to the Cloudflare API (/user/tokens/verify) failed.\n  Invalid API Token [code: 9109]\n",
    }),
    'exit=1; HTTP=403; API code=10000; message="Authentication error"',
  );
});

test("arbitrary messages, bindings, tokens, paths and workflow commands never pass through", () => {
  const secret = "secret://TEAM_DOMAIN=private.example/CF_ACCESS_SECRET";
  const result = wranglerFailure({
    code: 1,
    stdout:
      request(path, 400) + `Your Worker has access to bindings: ${secret}\n`,
    stderr: stderr(`${secret} ::error::injected`, 10021) + `\n${secret}`,
    message: secret,
    signal: secret,
  });
  assert.equal(
    result,
    'exit=1; HTTP=400; API code=10021; message="suppressed (not allowlisted)"',
  );
  for (const value of [
    secret,
    "private-worker",
    "aaaaaaaa",
    "::error::",
    "TEAM_DOMAIN",
  ])
    assert(!result.includes(value));
});

test("unknown/local/transport errors fail closed and never borrow a previous HTTP status", () => {
  assert.equal(
    wranglerFailure({
      code: "ENOENT",
      stderr: "secret [code: 999]",
      stdout: request(path, 403),
    }),
    'exit=unknown; HTTP=unknown; API code=unknown; message="suppressed (not allowlisted)"',
  );
  assert.equal(
    wranglerFailure({
      code: 1,
      stderr: stderr("Authentication error EXTRA_SECRET", 10000),
    }),
    'exit=1; HTTP=unknown; API code=10000; message="suppressed (not allowlisted)"',
  );
  assert.equal(
    wranglerFailure({
      code: 1,
      stderr: stderr("Authentication error", "123secret"),
    }),
    'exit=1; HTTP=unknown; API code=unknown; message="suppressed (not allowlisted)"',
  );
  assert.equal(
    wranglerFailure({
      code: "SECRET",
      stderr: stderr("Authentication error", 10000),
      stdout: request("/other", 403),
    }),
    'exit=unknown; HTTP=unknown; API code=10000; message="Authentication error"',
  );
});

test("ANSI and wrapped messages are safe; successful HTTP envelope errors retain status 200", () => {
  assert.equal(
    wranglerFailure({
      code: 1,
      stdout: request(path, 200),
      stderr: `\u001b[31m✘ [ERROR]\u001b[0m A request to the Cloudflare API (${path}) failed.\n  Authentication error\n  [code: 10000]\n`,
    }),
    'exit=1; HTTP=200; API code=10000; message="Authentication error"',
  );
});

test("diagnostic env forces capture, sanitization and no persistent logs or error reports", () => {
  const env = wranglerDiagnosticEnv({
    WRANGLER_LOG: "log",
    WRANGLER_LOG_SANITIZE: "false",
    WRANGLER_WRITE_LOGS: "true",
    WRANGLER_SEND_ERROR_REPORTS: "true",
    CLOUDFLARE_API_TOKEN: "synthetic",
  });
  assert.equal(env.WRANGLER_LOG, "debug");
  assert.equal(env.WRANGLER_LOG_SANITIZE, "true");
  assert.equal(env.WRANGLER_WRITE_LOGS, "false");
  assert.equal(env.WRANGLER_SEND_ERROR_REPORTS, "false");
  assert.equal(env.CLOUDFLARE_API_TOKEN, "synthetic");
});

test(
  "pinned real Wrangler against loopback API emits only safe primary failure details",
  { timeout: 30000 },
  async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "selfhost-diagnostic-test-"),
    );
    const requests = [];
    const server = createServer((req, res) => {
      requests.push([req.method, req.url]);
      res.writeHead(req.url.startsWith("/user/") ? 401 : 403, {
        "content-type": "application/json",
      });
      res.end(
        JSON.stringify({
          success: false,
          errors: [
            {
              code: req.url.startsWith("/user/") ? 9109 : 10000,
              message: req.url.startsWith("/user/")
                ? "Invalid API Token"
                : "Authentication error",
            },
          ],
          result: null,
        }),
      );
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      await writeFile(
        join(directory, "index.mjs"),
        'export default {fetch() {return new Response("ok")}}',
      );
      await writeFile(
        join(directory, "wrangler.json"),
        JSON.stringify({
          name: "private-worker",
          main: "index.mjs",
          compatibility_date: "2026-06-01",
        }),
      );
      let failure;
      try {
        await promisify(execFile)(
          process.execPath,
          [
            "node_modules/wrangler/bin/wrangler.js",
            "versions",
            "upload",
            "-c",
            join(directory, "wrangler.json"),
          ],
          {
            env: wranglerDiagnosticEnv({
              PATH: process.env.PATH,
              HOME: directory,
              TMPDIR: directory,
              CI: "true",
              CLOUDFLARE_API_TOKEN: "synthetic",
              CLOUDFLARE_ACCOUNT_ID: "a".repeat(32),
              CLOUDFLARE_API_BASE_URL: `http://127.0.0.1:${server.address().port}`,
              WRANGLER_SEND_METRICS: "false",
            }),
            maxBuffer: 16 * 1024 * 1024,
            timeout: 20000,
          },
        );
      } catch (error) {
        failure = error;
      }
      assert(failure, "Loopback API rejects the real Wrangler upload");
      assert.equal(
        wranglerFailure(failure),
        'exit=1; HTTP=403; API code=10000; message="Authentication error"',
      );
      assert(
        requests.some(([method, url]) => method === "GET" && url === path),
      );
      assert(
        requests.every(([method]) => method === "GET"),
        "Failure stops before any upload or activation",
      );
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      await rm(directory, { recursive: true, force: true });
    }
  },
);
