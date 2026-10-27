import { createHash } from "node:crypto";
import { readFile, writeFile, mkdtemp, rm, readdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { decideDeployWindow } from "./deploy-window.mjs";
import {
  wranglerDiagnosticEnv,
  wranglerFailure,
} from "./wrangler-diagnostics.mjs";
import { makeWorkerAssets } from "../../deploy/alchemy/alchemy.assets.ts";

// Commands use execFile argument arrays, never a shell.
const execFile = promisify(execFileCb);
const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const API = "https://api.cloudflare.com/client/v4";
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA = /^[0-9a-f]{40}$/;
export const WORKERS = ["open-seo-selfhost-audit", "open-seo-selfhost"];
const ENTRIES = ["dist/open_seo_audit/index.js", "dist/server/index.js"];
const BASELINE_PATHS = [
  "drizzle/sqlite",
  "wrangler.jsonc",
  "wrangler.audit.jsonc",
  "deploy/alchemy",
];
function assert(ok, message) {
  if (!ok) throw new Error(message);
}

export function activeId(deployments, worker) {
  // History is newest first. Only its head is active.
  const versions = deployments?.[0]?.versions;
  assert(
    versions?.length === 1 &&
      versions[0].percentage === 100 &&
      UUID.test(versions[0].version_id),
    `${worker}: require one active version at 100%`,
  );
  return versions[0].version_id;
}

export function validateSnapshot(snapshot, worker) {
  const id = activeId(snapshot?.deployments, worker);
  assert(
    snapshot.versions?.[0]?.id === id,
    `${worker}: pending version; review before automatic deployment`,
  );
  assert(snapshot.active?.id === id, `${worker}: active metadata mismatch`);
  const resources = snapshot.active.resources;
  assert(
    resources?.script_runtime?.compatibility_date &&
      Array.isArray(resources.bindings) &&
      resources.bindings.length > 0,
    `${worker}: incomplete metadata`,
  );
  const names = resources.bindings.map((binding) => binding.name);
  assert(
    names.every((name) => typeof name === "string" && name.length > 0) &&
      new Set(names).size === names.length,
    `${worker}: invalid binding names`,
  );
  if (worker === "open-seo-selfhost") {
    for (const required of [
      "AUTH_MODE",
      "TEAM_DOMAIN",
      "POLICY_AUD",
      "DB",
      "ASSETS",
    ])
      assert(
        names.includes(required),
        `${worker}: required binding ${required} missing`,
      );
    assert(
      resources.bindings.find((binding) => binding.name === "AUTH_MODE")
        ?.text === "cloudflare_access",
      `${worker}: expected cloudflare_access mode`,
    );
  }
  return snapshot.active;
}

export function makeWranglerConfig(worker, active) {
  const index = WORKERS.indexOf(worker);
  assert(
    index >= 0 && UUID.test(active.id),
    "Unknown Worker or invalid source version",
  );
  const bindings = active.resources.bindings;
  const assets = bindings.filter((binding) => binding.type === "assets");
  assert(
    index === 0 ? assets.length === 0 : assets.length === 1,
    `${worker}: unexpected assets configuration`,
  );
  const runtime = active.resources.script_runtime;
  const config = {
    name: worker,
    main: resolve(ROOT, ENTRIES[index]),
    compatibility_date: runtime.compatibility_date,
    compatibility_flags: runtime.compatibility_flags ?? [],
    ...(runtime.limits ? { limits: runtime.limits } : {}),
    no_bundle: true,
    find_additional_modules: true,
    rules: [{ type: "ESModule", globs: ["**/*.js"] }],
    unsafe: {
      bindings: bindings
        .filter((binding) => binding.type !== "assets")
        .map((binding) => ({
          name: binding.name,
          type: "inherit",
          version_id: active.id,
        })),
    },
  };
  if (index === 1) {
    const { directory, runWorkerFirst } = makeWorkerAssets("selfhost");
    config.assets = {
      directory: resolve(ROOT, directory),
      binding: assets[0].name,
      run_worker_first: runWorkerFirst,
    };
    config.placement = { mode: "smart" };
  }
  return config;
}

export async function fingerprint() {
  const files = [];
  async function walk(path) {
    for (const item of await readdir(resolve(ROOT, path), {
      withFileTypes: true,
    })) {
      const name = `${path}/${item.name}`;
      if (item.isDirectory()) await walk(name);
      else files.push(name);
    }
  }
  for (const path of BASELINE_PATHS) {
    if (["drizzle/sqlite", "deploy/alchemy"].includes(path)) await walk(path);
    else files.push(path);
  }
  const rows = [];
  for (const path of files.toSorted())
    rows.push([
      path,
      createHash("sha256")
        .update(await readFile(resolve(ROOT, path)))
        .digest("hex"),
    ]);
  return createHash("sha256").update(JSON.stringify(rows)).digest("hex");
}

export async function verifyBaseline() {
  const expected = JSON.parse(
    await readFile(new URL("./baseline.json", import.meta.url), "utf8"),
  ).sha256;
  assert(
    (await fingerprint()) === expected,
    "Infrastructure/schema changed: manually reconcile/migrate and review baseline before deployment",
  );
}

export function createApi({ accountId, token, fetchImpl = fetch }) {
  assert(/^[0-9a-f]{32}$/i.test(accountId), "Invalid Cloudflare account ID");
  return async (method, worker, collection, body) => {
    assert(WORKERS.includes(worker), "API Worker outside allowlist");
    assert(
      (method === "GET" &&
        (/^(deployments|versions)$/.test(collection) ||
          (/^versions\/[0-9a-f-]+$/i.test(collection) &&
            UUID.test(collection.slice(9))))) ||
        (method === "POST" && collection === "deployments"),
      "API method/path outside allowlist",
    );
    const path = `/accounts/${accountId}/workers/scripts/${worker}/${collection}`;
    try {
      const response = await fetchImpl(`${API}${path}`, {
        method,
        redirect: "error",
        signal: AbortSignal.timeout(60000),
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      const data = await response.json();
      assert(response.ok && data.success === true, "Request rejected");
      return data.result;
    } catch {
      // API and transport errors may contain binding values.
      throw new Error(
        `Cloudflare ${method} ${worker}/${collection} failed; response suppressed`,
      );
    }
  };
}

export async function snapshotWorker(api, worker) {
  const [deploymentResult, versionResult] = await Promise.all([
    api("GET", worker, "deployments"),
    api("GET", worker, "versions"),
  ]);
  const deployments = deploymentResult.deployments;
  const versions = versionResult.items;
  const id = activeId(deployments, worker);
  const active = await api("GET", worker, `versions/${id}`);
  return { deployments, versions, active };
}

export async function guard({ env, exec, now }) {
  assert(
    SHA.test(env.CANDIDATE_SHA ?? ""),
    "CANDIDATE_SHA must be 40 lowercase hex characters",
  );
  assert(decideDeployWindow(now()).allowed, "Deployment window blocked");
  const { stdout } = await exec(
    "git",
    ["ls-remote", "origin", "refs/heads/main"],
    { cwd: ROOT },
  );
  assert(
    stdout.trim().split(/\s+/)[0] === env.CANDIDATE_SHA,
    "Candidate is no longer origin/main tip",
  );
  assert(decideDeployWindow(now()).allowed, "Deployment window blocked");
}

export async function run({
  mode,
  snapshotFile,
  env = process.env,
  fetchImpl = fetch,
  exec = execFile,
  now = () => new Date(),
} = {}) {
  assert(
    ["plan", "deploy"].includes(mode),
    "Usage: --plan|--deploy [--snapshot FILE]",
  );
  assert(!snapshotFile || mode === "plan", "Offline snapshots are plan-only");
  await verifyBaseline();
  const offline = snapshotFile
    ? JSON.parse(await readFile(resolve(snapshotFile), "utf8"))
    : null;
  if (!offline)
    assert(env.CLOUDFLARE_API_TOKEN, "CLOUDFLARE_API_TOKEN is required");
  const api = offline
    ? null
    : createApi({
        accountId: env.CLOUDFLARE_ACCOUNT_ID,
        token: env.CLOUDFLARE_API_TOKEN,
        fetchImpl,
      });
  const snapshots = {};
  for (const worker of WORKERS) {
    snapshots[worker] =
      offline?.[worker] ?? (await snapshotWorker(api, worker));
    validateSnapshot(snapshots[worker], worker);
  }
  const directory = await mkdtemp(
    resolve(env.RUNNER_TEMP ?? env.TMPDIR ?? ROOT, "open-seo-ci-"),
  );
  const uploads = {};
  try {
    for (const worker of WORKERS) {
      const path = join(directory, `${worker}.json`);
      const output = join(directory, `${worker}.jsonl`);
      await writeFile(
        path,
        JSON.stringify(makeWranglerConfig(worker, snapshots[worker].active)),
      );
      if (mode === "deploy") await guard({ env, exec, now });
      try {
        await exec(
          "pnpm",
          [
            "exec",
            "wrangler",
            "versions",
            "upload",
            "-c",
            path,
            ...(mode === "plan"
              ? ["--dry-run"]
              : ["--message", `selfhost-ci:${env.CANDIDATE_SHA}`]),
          ],
          {
            cwd: ROOT,
            env: wranglerDiagnosticEnv({
              ...env,
              WRANGLER_SEND_METRICS: "false",
              WRANGLER_OUTPUT_FILE_PATH: output,
              WRANGLER_LOG_PATH: join(directory, "wrangler.log"),
            }),
            maxBuffer: 16 * 1024 * 1024,
          },
        );
      } catch (error) {
        throw new Error(
          `${worker}: Wrangler ${mode} failed; ${wranglerFailure(error)}; raw output suppressed to protect bindings`,
        );
      }
      if (mode === "deploy") {
        const records = (await readFile(output, "utf8"))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
        uploads[worker] = records.find(
          (record) => record.type === "version-upload",
        )?.version_id;
        assert(
          UUID.test(uploads[worker] ?? ""),
          `${worker}: missing Wrangler version ID`,
        );
      }
    }
    if (mode === "plan")
      return "Plan passed for both Worker bundles (no remote writes)";
    // Upload both first, then activate audit before app. This is not atomic.
    for (const worker of WORKERS) {
      const current = await api("GET", worker, "deployments");
      assert(
        activeId(current.deployments, worker) === snapshots[worker].active.id,
        `${worker}: concurrent active-version change`,
      );
    }
    for (const worker of WORKERS) {
      const current = await api("GET", worker, "deployments");
      assert(
        activeId(current.deployments, worker) === snapshots[worker].active.id,
        `${worker}: concurrent active-version change`,
      );
      await guard({ env, exec, now });
      await api("POST", worker, "deployments", {
        strategy: "percentage",
        versions: [{ version_id: uploads[worker], percentage: 100 }],
      });
      const readback = await api("GET", worker, "deployments");
      assert(
        activeId(readback.deployments, worker) === uploads[worker],
        `${worker}: deployment readback mismatch`,
      );
      console.log(`${worker}: deployed version ${uploads[worker]}`);
    }
    return "Both Worker deployments read back successfully";
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const args = process.argv.slice(2);
  const mode =
    args[0] === "--plan"
      ? "plan"
      : args[0] === "--deploy"
        ? "deploy"
        : undefined;
  const valid =
    args.length === 1 || (args.length === 3 && args[1] === "--snapshot");
  (valid
    ? run({ mode, snapshotFile: args[2] })
    : Promise.reject(new Error("Invalid arguments"))
  )
    .then(console.log)
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
}
