import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { BLOCKED_INTERVALS, decideDeployWindow } from "./deploy-window.mjs";

const cli = fileURLToPath(new URL("./deploy-window.mjs", import.meta.url));
const projectRoot = fileURLToPath(new URL("../../", import.meta.url));
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
const jstInstant = (minute, second = 0, millisecond = 0) =>
  new Date(
    Date.UTC(2026, 9, 26, 0, minute, second, millisecond) - JST_OFFSET_MS,
  );
const isBlocked = (minute) =>
  (minute >= 370 && minute < 445) || (minute >= 990 && minute < 1050);

test("every minute of a JST day follows the half-open blocked interval table", () => {
  for (let minute = 0; minute < 24 * 60; minute++) {
    const result = decideDeployWindow(jstInstant(minute));
    assert.equal(result.allowed, !isBlocked(minute), `minute ${minute}`);
    assert.match(result.jst, /^2026-10-26T/);
    assert.equal(
      result.jst.slice(11, 16),
      `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`,
    );
  }
});

test("blocked intervals include their first second and exclude the end boundary", () => {
  for (const { start, end } of BLOCKED_INTERVALS) {
    assert.equal(decideDeployWindow(jstInstant(start, 0, 0)).allowed, false);
    assert.equal(decideDeployWindow(jstInstant(start, 0, 1)).allowed, false);
    assert.equal(
      decideDeployWindow(jstInstant(end - 1, 59, 999)).allowed,
      false,
    );
    assert.equal(decideDeployWindow(jstInstant(end, 0, 0)).allowed, true);
    assert.equal(decideDeployWindow(jstInstant(start, 0, 0) - 1).allowed, true);
  }
});

test("UTC-to-JST conversion handles the previous and next UTC date correctly", () => {
  assert.equal(
    decideDeployWindow("2026-10-25T15:00:00.000Z").jst,
    "2026-10-26T00:00:00.000+09:00",
  );
  assert.equal(
    decideDeployWindow("2026-10-26T15:00:00.000Z").jst,
    "2026-10-27T00:00:00.000+09:00",
  );
  assert.equal(
    decideDeployWindow("2026-10-25T21:10:00.000Z").reason,
    "blocked_window_06:10-07:25_JST",
  );
});

test("invalid instants fail closed", () => {
  assert.throws(() => decideDeployWindow("not-a-date"), /valid date/);
});

test("CLI appends decision outputs and is independent of host timezone", async () => {
  const directory = await mkdtemp(join(tmpdir(), "readwiser-deploy-window-"));
  try {
    const outputs = [];
    for (const TZ of ["UTC", "Pacific/Honolulu", "Pacific/Kiritimati"]) {
      const output = join(directory, `${TZ.replaceAll("/", "-")}.txt`);
      const result = spawnSync(
        process.execPath,
        [cli, "--at", "2026-10-25T21:10:00.000Z"],
        {
          env: { ...process.env, TZ, GITHUB_OUTPUT: output },
          encoding: "utf8",
        },
      );
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /blocked at 2026-10-26T06:10:00.000\+09:00/);
      outputs.push(await readFile(output, "utf8"));
    }
    assert.deepEqual(outputs, [
      "allowed=false\nreason=blocked_window_06:10-07:25_JST\njst=2026-10-26T06:10:00.000+09:00\n",
      "allowed=false\nreason=blocked_window_06:10-07:25_JST\njst=2026-10-26T06:10:00.000+09:00\n",
      "allowed=false\nreason=blocked_window_06:10-07:25_JST\njst=2026-10-26T06:10:00.000+09:00\n",
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("CLI runs when invoked with the workflow relative path", async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "readwiser-deploy-window-relative-"),
  );
  const output = join(directory, "outputs.txt");
  try {
    const result = spawnSync(
      process.execPath,
      [
        "scripts/selfhost-ci/deploy-window.mjs",
        "--at",
        "2026-10-26T00:00:00.000Z",
      ],
      {
        cwd: projectRoot,
        env: { ...process.env, GITHUB_OUTPUT: output },
        encoding: "utf8",
      },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      await readFile(output, "utf8"),
      "allowed=true\nreason=outside_blocked_window\njst=2026-10-26T09:00:00.000+09:00\n",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("CLI requires GitHub Actions output file", () => {
  const result = spawnSync(
    process.execPath,
    [cli, "--at", "2026-10-26T00:00:00Z"],
    {
      env: { ...process.env, GITHUB_OUTPUT: "" },
      encoding: "utf8",
    },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /GITHUB_OUTPUT is required/);
});
