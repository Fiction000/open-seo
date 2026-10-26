import test from "node:test";
import assert from "node:assert/strict";
import { checkProduction } from "./health-check.mjs";

test("authenticated GET requires exact 200 without following Access redirects", async () => {
  const env = {
    CLOUDFLARE_ACCESS_CLIENT_ID: "synthetic-id",
    CLOUDFLARE_ACCESS_CLIENT_SECRET: "synthetic-secret",
  };
  for (const status of [200, 302, 403, 500]) {
    const request = checkProduction({
      env,
      fetchImpl: async (url, options) => {
        assert.equal(url, "https://seo.katot.dev/");
        assert.equal(options.redirect, "manual");
        assert.deepEqual(options.headers, {
          "CF-Access-Client-Id": "synthetic-id",
          "CF-Access-Client-Secret": "synthetic-secret",
        });
        return new Response(null, { status });
      },
    });
    if (status === 200) assert.match(await request, /HTTP 200/);
    else await assert.rejects(request, /expected HTTP 200/);
  }
  await assert.rejects(checkProduction({ env: {} }), /both Access/);
});
