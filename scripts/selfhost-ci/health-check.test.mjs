import test from "node:test";
import assert from "node:assert/strict";
import { checkProduction } from "./health-check.mjs";

const env = {
  CLOUDFLARE_ACCESS_CLIENT_ID: "synthetic-id",
  CLOUDFLARE_ACCESS_CLIENT_SECRET: "synthetic-secret",
};

test("authenticated GET checks health JSON without following redirects", async () => {
  const result = await checkProduction({
    env,
    fetchImpl: async (url, options) => {
      assert.equal(url, "https://seo.katot.dev/api/health");
      assert.equal(options.method, "GET");
      assert.equal(options.redirect, "manual");
      assert.deepEqual(options.headers, {
        "CF-Access-Client-Id": env.CLOUDFLARE_ACCESS_CLIENT_ID,
        "CF-Access-Client-Secret": env.CLOUDFLARE_ACCESS_CLIENT_SECRET,
      });
      return Response.json({ status: "ok", checks: {} });
    },
  });
  assert.match(result, /api\/health: HTTP 200, status ok without redirects/);
});

test("rejects redirects, HTTP failures, and invalid health results with safe diagnostics", async () => {
  for (const [status, body, contentType, classification] of [
    [302, "", "text/html", "html-page"],
    [403, '{"error":"forbidden"}', "application/json", "app-forbidden"],
    [
      403,
      "<html>Cloudflare Access synthetic-secret</html>",
      "text/html",
      "access-page",
    ],
    [500, '{"status":"ok"}', "application/json", "json"],
    [200, '{"status":"issues"}', "application/json", "json"],
    [200, '{"status":"OK"}', "application/json", "json"],
    [200, "null", "application/json", "json"],
    [200, "not-json synthetic-secret", "text/plain", "other"],
    [200, "<html>Cloudflare Access</html>", "text/html", "access-page"],
  ]) {
    await assert.rejects(
      checkProduction({
        env,
        fetchImpl: async () =>
          new Response(body, {
            status,
            headers: {
              "cf-ray": "1234567890abcdef-NRT",
              "content-type": contentType,
            },
          }),
      }),
      (error) => {
        assert.match(error.message, /expected HTTP 200 with JSON status "ok"/);
        assert.ok(error.message.includes(`status=${status}`));
        assert.ok(error.message.includes("cf-ray=1234567890abcdef-NRT"));
        assert.ok(error.message.includes(`content-type=${contentType}`));
        assert.ok(error.message.includes(`body=${classification}`));
        assert.doesNotMatch(
          error.message,
          /synthetic-id|synthetic-secret|CF-Access-Client/i,
        );
        return true;
      },
    );
  }
});

test("suppresses reflected headers and arbitrary network or body errors", async () => {
  for (const fetchImpl of [
    async () => {
      throw new Error("synthetic-secret");
    },
    async () => ({
      status: 403,
      headers: new Headers({
        "cf-ray": "synthetic-secret",
        "content-type": "text/html; private=synthetic-id",
      }),
      text: async () => {
        throw new Error("synthetic-secret");
      },
    }),
  ]) {
    await assert.rejects(checkProduction({ env, fetchImpl }), (error) => {
      assert.doesNotMatch(
        error.message,
        /synthetic-id|synthetic-secret|CF-Access-Client/i,
      );
      assert.match(error.message, /Production verification/);
      return true;
    });
  }
});

test("requires both Access credentials before a request", async () => {
  for (const credentials of [
    {},
    { CLOUDFLARE_ACCESS_CLIENT_ID: "synthetic-id" },
    { CLOUDFLARE_ACCESS_CLIENT_SECRET: "synthetic-secret" },
  ]) {
    await assert.rejects(
      checkProduction({
        env: credentials,
        fetchImpl: async () => {
          assert.fail("must not fetch");
        },
      }),
      /both Access credentials/,
    );
  }
});
