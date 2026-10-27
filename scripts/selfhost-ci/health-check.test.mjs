import test from "node:test";
import assert from "node:assert/strict";
import { checkProduction } from "./health-check.mjs";

const env = {
  CLOUDFLARE_ACCESS_CLIENT_ID: "synthetic-id",
  CLOUDFLARE_ACCESS_CLIENT_SECRET: "synthetic-secret",
};
const quiet = { logImpl: () => {} };

function assertSafe(message) {
  assert.doesNotMatch(
    message,
    /synthetic-id|synthetic-secret|CF-Access-Client/i,
  );
}

test("authenticated GET checks health JSON without following redirects", async () => {
  const result = await checkProduction({
    env,
    ...quiet,
    sleepImpl: async () => assert.fail("must not wait after success"),
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

test("403 and every 5xx can recover on the next attempt", async () => {
  for (const status of [
    403,
    ...Array.from({ length: 100 }, (_, i) => 500 + i),
  ]) {
    let calls = 0;
    const waits = [];
    const logs = [];
    let signal;
    await checkProduction({
      env,
      logImpl: (line) => logs.push(line),
      sleepImpl: async (ms, value, options) => {
        waits.push(ms);
        assert.equal(options.signal, signal);
      },
      fetchImpl: async (url, options) => {
        assert.equal(options.redirect, "manual");
        assert.equal(url, "https://seo.katot.dev/api/health");
        if (signal) assert.equal(options.signal, signal);
        signal = options.signal;
        calls++;
        return calls === 1
          ? new Response("synthetic-secret", { status })
          : Response.json({ status: "ok" });
      },
    });
    assert.equal(calls, 2);
    assert.deepEqual(waits, [3000]);
    assert.equal(logs.length, 2);
    assertSafe(logs.join("\n"));
  }
});

test("persistent retryable responses stop at six attempts with safe diagnostics", async () => {
  for (const [status, body, contentType, classification] of [
    [403, '{"error":"forbidden"}', "application/json", "app-forbidden"],
    [
      403,
      "<html>Cloudflare Access synthetic-secret</html>",
      "text/html",
      "access-page",
    ],
    [500, '{"status":"ok"}', "application/json", "json"],
  ]) {
    let calls = 0;
    const waits = [];
    const logs = [];
    await assert.rejects(
      checkProduction({
        env,
        logImpl: (line) => logs.push(line),
        sleepImpl: async (ms) => waits.push(ms),
        fetchImpl: async () => {
          calls++;
          return new Response(body, {
            status,
            headers: {
              "cf-ray": "1234567890abcdef-NRT",
              "content-type": contentType,
            },
          });
        },
      }),
      (error) => {
        assert.match(error.message, /expected HTTP 200 with JSON status "ok"/);
        assert.ok(error.message.includes(`status=${status}`));
        assert.ok(error.message.includes("cf-ray=1234567890abcdef-NRT"));
        assert.ok(error.message.includes(`content-type=${contentType}`));
        assert.ok(error.message.includes(`body=${classification}`));
        assertSafe(error.message);
        return true;
      },
    );
    assert.equal(calls, 6);
    assert.deepEqual(waits, [3000, 3000, 3000, 3000, 3000]);
    assert.equal(logs.length, 6);
    assertSafe(logs.join("\n"));
  }
});

test("redirects, other 4xx and invalid health JSON fail without a retry", async () => {
  for (const [status, body] of [
    [201, '{"status":"ok"}'],
    [301, ""],
    [302, ""],
    [307, ""],
    [308, ""],
    [400, ""],
    [401, ""],
    [404, ""],
    [429, ""],
    [200, '{"status":"issues"}'],
    [200, '{"status":"OK"}'],
    [200, "null"],
    [200, "not-json synthetic-secret"],
    [200, "<html>Cloudflare Access</html>"],
  ]) {
    let calls = 0;
    await assert.rejects(
      checkProduction({
        env,
        ...quiet,
        sleepImpl: async () => assert.fail("must not wait"),
        fetchImpl: async () => {
          calls++;
          return new Response(body, { status });
        },
      }),
      /expected HTTP 200 with JSON status "ok"/,
    );
    assert.equal(calls, 1);
  }
});

test("a terminal response after a retry stops immediately", async () => {
  let calls = 0;
  const waits = [];
  await assert.rejects(
    checkProduction({
      env,
      ...quiet,
      sleepImpl: async (ms) => waits.push(ms),
      fetchImpl: async () =>
        new Response("", { status: ++calls === 1 ? 503 : 401 }),
    }),
    /status=401/,
  );
  assert.equal(calls, 2);
  assert.deepEqual(waits, [3000]);
});

test("suppresses reflected headers and fails immediately on network or body errors", async () => {
  for (const response of [
    new Error("synthetic-secret"),
    {
      status: 403,
      headers: new Headers({
        "cf-ray": "synthetic-secret",
        "content-type": "text/html; private=synthetic-id",
      }),
      text: async () => {
        throw new Error("synthetic-secret");
      },
    },
  ]) {
    let calls = 0;
    const logs = [];
    await assert.rejects(
      checkProduction({
        env,
        logImpl: (line) => logs.push(line),
        sleepImpl: async () => assert.fail("must not wait"),
        fetchImpl: async () => {
          calls++;
          if (response instanceof Error) throw response;
          return response;
        },
      }),
      (error) => {
        assertSafe(error.message);
        assert.match(error.message, /Production verification/);
        return true;
      },
    );
    assert.equal(calls, 1);
    assertSafe(logs.join("\n"));
  }
});

test("one 30-second deadline covers requests, body reads and waits", async (t) => {
  const controller = new AbortController();
  const timeouts = [];
  t.mock.method(AbortSignal, "timeout", (ms) => {
    timeouts.push(ms);
    return controller.signal;
  });
  let calls = 0;
  await assert.rejects(
    checkProduction({
      env,
      ...quiet,
      fetchImpl: async (url, options) => {
        calls++;
        assert.equal(options.signal, controller.signal);
        return new Response("", { status: 503 });
      },
      sleepImpl: async (ms, value, options) => {
        assert.equal(options.signal, controller.signal);
        controller.abort(new Error("synthetic-secret"));
        options.signal.throwIfAborted();
      },
    }),
    (error) => {
      assertSafe(error.message);
      assert.match(error.message, /Production verification/);
      return true;
    },
  );
  assert.deepEqual(timeouts, [30000]);
  assert.equal(calls, 1);
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
        ...quiet,
        fetchImpl: async () => assert.fail("must not fetch"),
      }),
      /both Access credentials/,
    );
  }
});
