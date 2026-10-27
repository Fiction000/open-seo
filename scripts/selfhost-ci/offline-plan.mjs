import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { WORKERS, makeWranglerConfig, run } from "./deploy-runtime.mjs";
import { fixtureSnapshot } from "./fixtures.mjs";

// Exercise real built bundles and pinned Wrangler, using synthetic metadata only.
const directory = await mkdtemp(join(tmpdir(), "open-seo-offline-plan-"));
try {
  const snapshots = fixtureSnapshot();
  const file = join(directory, "synthetic-snapshots.json");
  await writeFile(file, JSON.stringify(snapshots));
  const safeEnv = {
    ...process.env,
    CLOUDFLARE_API_TOKEN: "",
    CLOUDFLARE_ACCOUNT_ID: "",
    WRANGLER_SEND_METRICS: "false",
    WRANGLER_LOG_PATH: join(directory, "wrangler.log"),
  };
  console.log(await run({ mode: "plan", snapshotFile: file, env: safeEnv }));
  for (const worker of WORKERS) {
    const config = makeWranglerConfig(worker, snapshots[worker].active);
    const configPath = join(directory, `${worker}.json`);
    const bundlePath = join(directory, `${worker}.multipart`);
    await writeFile(configPath, JSON.stringify(config));
    await promisify(execFile)(
      "pnpm",
      [
        "exec",
        "wrangler",
        "versions",
        "upload",
        "-c",
        configPath,
        "--dry-run",
        "--outfile",
        bundlePath,
      ],
      { env: safeEnv, maxBuffer: 16 * 1024 * 1024 },
    );
    const body = await readFile(bundlePath, "utf8");
    const match = body.match(/name="metadata"\r\n\r\n([^\r]+)\r\n/);
    assert(match, "Wrangler must emit multipart metadata");
    const metadata = JSON.parse(match[1]);
    const inherited = metadata.bindings.filter(
      (binding) => binding.type !== "assets",
    );
    assert.deepEqual(inherited, config.unsafe.bindings);
    assert(
      inherited.every((binding) => binding.version_id === "latest"),
      "Stable versions upload accepts only latest as an inherit source",
    );
    assert(metadata.keep_bindings.includes("secret_text"));
    for (const forbidden of [
      "routes",
      "domains",
      "triggers",
      "migrations",
      "workflows",
    ])
      assert.equal(forbidden in metadata, false);
    assert(body.includes('name="index.js"'));
    assert(
      body.includes('name="assets/'),
      "Sibling Worker chunks must be included",
    );
    console.log(
      `${worker}: real Wrangler multipart validated, ${inherited.length} latest inherit bindings; no infrastructure/migration declarations`,
    );
  }
} finally {
  await rm(directory, { recursive: true, force: true });
}
