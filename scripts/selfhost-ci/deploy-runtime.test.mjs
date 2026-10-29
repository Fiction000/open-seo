import test from "node:test";
import assert from "node:assert/strict";
import { writeFile, readFile } from "node:fs/promises";
import {
  WORKERS,
  activeId,
  validateSnapshot,
  makeWranglerConfig,
  createApi,
  guard,
  run,
  assertBaseline,
  verifyBaseline,
} from "./deploy-runtime.mjs";
import { fixtureSnapshot, SOURCE_IDS, UPLOAD_IDS } from "./fixtures.mjs";
const sha = "a".repeat(40);
const env = {
  ...process.env,
  CANDIDATE_SHA: sha,
  CLOUDFLARE_ACCOUNT_ID: "b".repeat(32),
  CLOUDFLARE_API_TOKEN: "synthetic-token",
};
const now = () => new Date("2026-10-26T01:00:00Z");

test("newest deployment alone is active; split, pending and mismatched versions fail closed", () => {
  const snapshot = fixtureSnapshot()[WORKERS[1]];
  snapshot.deployments.push({
    versions: [{ version_id: SOURCE_IDS[0], percentage: 100 }],
  });
  assert.equal(activeId(snapshot.deployments), SOURCE_IDS[1]);
  assert.equal(validateSnapshot(snapshot, WORKERS[1]).id, SOURCE_IDS[1]);
  snapshot.versions.unshift({ id: UPLOAD_IDS[1] });
  assert.throws(() => validateSnapshot(snapshot, WORKERS[1]), /pending/);
  snapshot.deployments[0].versions[0].percentage = 50;
  assert.throws(() => activeId(snapshot.deployments), /100%/);
});

test("stable version upload inherits latest without values or provisioning declarations", () => {
  const snapshot = fixtureSnapshot();
  for (const worker of WORKERS) {
    const active = validateSnapshot(snapshot[worker], worker);
    const config = makeWranglerConfig(worker, active);
    assert.deepEqual(
      config.unsafe.bindings,
      active.resources.bindings
        .filter((b) => b.type !== "assets")
        .map((b) => ({ name: b.name, type: "inherit", version_id: "latest" })),
    );
    for (const key of [
      "routes",
      "route",
      "workers_dev",
      "preview_urls",
      "triggers",
      "workflows",
      "durable_objects",
      "migrations",
      "vars",
      "d1_databases",
    ])
      assert.equal(key in config, false);
    assert.equal(JSON.stringify(config).includes("DO-NOT-LOG"), false);
    assert.equal(Boolean(config.assets), worker === WORKERS[1]);
    assert.equal(Boolean(config.placement), worker === WORKERS[1]);
  }
});

test("API allowlist rejects forbidden endpoints before fetch and sanitizes API errors", async () => {
  const calls = [];
  const api = createApi({
    accountId: env.CLOUDFLARE_ACCOUNT_ID,
    token: env.CLOUDFLARE_API_TOKEN,
    fetchImpl: async (url, init) => {
      calls.push([url, init]);
      return { ok: true, json: async () => ({ success: true, result: {} }) };
    },
  });
  await api("GET", WORKERS[0], "deployments");
  for (const collection of [
    "routes",
    "settings",
    "domains",
    "access",
    "versions/../settings",
    "versions/not-uuid",
  ])
    await assert.rejects(api("GET", WORKERS[0], collection), /allowlist/);
  for (const method of ["POST", "PUT", "DELETE", "PATCH"])
    await assert.rejects(api(method, WORKERS[0], "versions"), /allowlist/);
  await assert.rejects(api("GET", "other-worker", "versions"), /allowlist/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][1].redirect, "error");
  const bad = createApi({
    accountId: env.CLOUDFLARE_ACCOUNT_ID,
    token: "fixture",
    fetchImpl: async () => {
      throw new Error("DO-NOT-LOG");
    },
  });
  await assert.rejects(
    bad("GET", WORKERS[0], "versions"),
    (error) =>
      !error.message.includes("DO-NOT-LOG") &&
      error.message.includes("suppressed"),
  );
});

test("each mutation guard rejects blocked time, stale main and malformed SHA", async () => {
  const exec = async () => ({ stdout: `${sha}\trefs/heads/main\n` });
  await guard({ env, exec, now });
  await assert.rejects(
    guard({ env, exec, now: () => new Date("2026-10-26T07:30:00Z") }),
    /window blocked/,
  );
  await assert.rejects(
    guard({ env, exec: async () => ({ stdout: "f".repeat(40) }), now }),
    /no longer/,
  );
  await assert.rejects(
    guard({ env: { CANDIDATE_SHA: "main" }, exec, now }),
    /40 lowercase/,
  );
  const times = [now(), new Date("2026-10-26T07:30:00Z")];
  await assert.rejects(
    guard({ env, exec, now: () => times.shift() }),
    /window blocked/,
  );
});

function harness({ changeActive = false, readbackMismatch = false } = {}) {
  const snapshots = fixtureSnapshot();
  const events = [];
  const current = Object.fromEntries(WORKERS.map((w, i) => [w, SOURCE_IDS[i]]));
  let uploads = 0;
  const staged = {};
  const exec = async (command, args, options) => {
    if (command === "git") {
      events.push("guard");
      return { stdout: `${sha}\trefs/heads/main` };
    }
    assert.equal(command, "pnpm");
    assert.deepEqual(args.slice(0, 4), [
      "exec",
      "wrangler",
      "versions",
      "upload",
    ]);
    const config = JSON.parse(await readFile(args[5], "utf8"));
    const index = WORKERS.indexOf(config.name);
    assert(index >= 0);
    uploads++;
    staged[config.name] = UPLOAD_IDS[index];
    events.push(`upload:${index}`);
    await writeFile(
      options.env.WRANGLER_OUTPUT_FILE_PATH,
      JSON.stringify({
        type: "version-upload",
        version_id: UPLOAD_IDS[index],
      }) + "\n",
    );
    return { stdout: "", stderr: "" };
  };
  const fetchImpl = async (url, init) => {
    const match = new URL(url).pathname.match(
      /\/scripts\/(open-seo-selfhost(?:-audit)?)\/(.+)$/,
    );
    assert(match);
    const [, worker, collection] = match;
    const index = WORKERS.indexOf(worker);
    let result;
    if (init.method === "POST") {
      assert.equal(collection, "deployments");
      assert.equal(uploads, 2);
      const body = JSON.parse(init.body);
      assert.deepEqual(body, {
        strategy: "percentage",
        versions: [{ version_id: UPLOAD_IDS[index], percentage: 100 }],
      });
      events.push(`activate:${index}`);
      if (!readbackMismatch) current[worker] = UPLOAD_IDS[index];
      result = { id: "synthetic" };
    } else if (collection === "deployments") {
      const id =
        changeActive && uploads === 2 ? UPLOAD_IDS[index] : current[worker];
      result = {
        deployments: [
          { versions: [{ version_id: id, percentage: 100 }] },
          ...snapshots[worker].deployments,
        ],
      };
    } else if (collection === "versions")
      result = {
        items: [
          ...(staged[worker] ? [{ id: staged[worker] }] : []),
          ...snapshots[worker].versions,
        ],
      };
    else if (collection === `versions/${SOURCE_IDS[index]}`)
      result = snapshots[worker].active;
    else assert.fail(`Unexpected endpoint ${collection}`);
    return { ok: true, json: async () => ({ success: true, result }) };
  };
  return { events, exec, fetchImpl };
}

test("full mocked deployment uploads both then activates audit/app with guards and exact readbacks", async () => {
  const h = harness();
  assert.match(
    await run({ mode: "deploy", env, now, ...h }),
    /read back successfully/,
  );
  assert.deepEqual(h.events, [
    "guard",
    "upload:0",
    "guard",
    "upload:1",
    "guard",
    "activate:0",
    "guard",
    "activate:1",
  ]);
});

test("manual deployment race prevents activation and failed readback prevents app activation", async () => {
  const race = harness({ changeActive: true });
  await assert.rejects(
    run({ mode: "deploy", env, now, ...race }),
    /concurrent/,
  );
  assert(!race.events.some((event) => event.startsWith("activate")));
  const mismatch = harness({ readbackMismatch: true });
  await assert.rejects(
    run({ mode: "deploy", env, now, ...mismatch }),
    /readback mismatch/,
  );
  assert(!mismatch.events.includes("activate:1"));
});

test("failed Wrangler upload reports safe API details and never activates either Worker", async () => {
  const h = harness();
  const exec = async (command, args, options) => {
    if (command === "git") return h.exec(command, args, options);
    const path = "/accounts/private-account/workers/services/private-worker";
    throw Object.assign(new Error("DO-NOT-LOG binding values"), {
      code: 1,
      stdout: `-- START CF API REQUEST: GET https://api.cloudflare.com/client/v4${path}\n-- START CF API RESPONSE: Forbidden 403\n`,
      stderr: `[ERROR] A request to the Cloudflare API (${path}) failed.\n  Authentication error [code: 10000]\nDO-NOT-LOG`,
    });
  };
  await assert.rejects(
    run({ mode: "deploy", env, now, fetchImpl: h.fetchImpl, exec }),
    (error) => {
      assert.match(
        error.message,
        /HTTP=403; API code=10000; message="Authentication error"/,
      );
      assert(!error.message.includes("DO-NOT-LOG"));
      assert(!error.message.includes("private-account"));
      assert.equal(error.cause, undefined);
      return true;
    },
  );
  assert.deepEqual(h.events, ["guard"]);
});

for (const stage of [
  "before-audit-upload",
  "before-app-upload",
  "during-audit-upload",
  "during-app-upload",
  "before-activation",
  "between-activations",
]) {
  test(`concurrent version at ${stage} blocks the next mutation`, async () => {
    const h = harness();
    const reads = {};
    const fetchImpl = async (url, init) => {
      const response = await h.fetchImpl(url, init);
      const data = await response.json();
      const worker = WORKERS.find((target) =>
        new URL(url).pathname.endsWith(`/scripts/${target}/versions`),
      );
      if (worker) {
        reads[worker] = (reads[worker] ?? 0) + 1;
        const race =
          (stage === "before-audit-upload" &&
            worker === WORKERS[0] &&
            reads[worker] === 2) ||
          (stage === "before-app-upload" &&
            worker === WORKERS[1] &&
            reads[worker] === 2) ||
          (stage === "during-audit-upload" &&
            worker === WORKERS[0] &&
            reads[worker] === 3) ||
          (stage === "during-app-upload" &&
            worker === WORKERS[1] &&
            reads[worker] === 3) ||
          (stage === "before-activation" && h.events.includes("upload:1")) ||
          (stage === "between-activations" && h.events.includes("activate:0"));
        if (race) {
          const index = stage.startsWith("during-") ? 1 : 0;
          data.result.items.splice(index, 0, {
            id: "55555555-5555-4555-8555-555555555555",
          });
        }
      }
      return { ok: true, json: async () => data };
    };
    await assert.rejects(
      run({ mode: "deploy", env, now, exec: h.exec, fetchImpl }),
      /pending version|lineage changed/,
    );
    assert(!h.events.includes("activate:1"));
    assert.equal(
      h.events.includes("activate:0"),
      stage === "between-activations",
    );
    if (stage === "before-audit-upload") assert(!h.events.includes("upload:0"));
    if (["before-app-upload", "during-audit-upload"].includes(stage))
      assert(!h.events.includes("upload:1"));
  });
}

test("offline snapshots cannot deploy and checked-in infrastructure baseline matches", async () => {
  await assert.rejects(
    run({ mode: "deploy", snapshotFile: "irrelevant" }),
    /plan-only/,
  );
  await verifyBaseline();
});

test("baseline guard rejects a changed infrastructure fingerprint", () => {
  const reviewed =
    "9e52b6afbe2119e2287f0dcb6da5aa87252e083b8a9f6d03d13154876d2ca0cd";
  const changed =
    "a420340085c322a1d56dd10b85aaba746bd586cac1547fa695cbbf7ec25a1a6f";
  assert.throws(
    () => assertBaseline(changed, reviewed),
    /Infrastructure\/schema changed: manually reconcile\/migrate and review baseline before deployment/,
  );
});
