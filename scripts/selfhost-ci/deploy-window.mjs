import { appendFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
export const BLOCKED_INTERVALS = Object.freeze([
  Object.freeze({ start: 6 * 60 + 10, end: 7 * 60 + 25 }),
  Object.freeze({ start: 16 * 60 + 30, end: 17 * 60 + 30 }),
]);

function isoInJst(date) {
  const shifted = new Date(date.getTime() + JST_OFFSET_MS);
  const year = shifted.getUTCFullYear();
  const month = String(shifted.getUTCMonth() + 1).padStart(2, "0");
  const day = String(shifted.getUTCDate()).padStart(2, "0");
  const hour = String(shifted.getUTCHours()).padStart(2, "0");
  const minute = String(shifted.getUTCMinutes()).padStart(2, "0");
  const second = String(shifted.getUTCSeconds()).padStart(2, "0");
  const millisecond = String(shifted.getUTCMilliseconds()).padStart(3, "0");
  return `${year}-${month}-${day}T${hour}:${minute}:${second}.${millisecond}+09:00`;
}

export function decideDeployWindow(instant = new Date()) {
  const date = instant instanceof Date ? instant : new Date(instant);
  if (!Number.isFinite(date.getTime()))
    throw new TypeError("instant must be a valid date");

  const jst = isoInJst(date);
  const shifted = new Date(date.getTime() + JST_OFFSET_MS);
  const minuteOfDay = shifted.getUTCHours() * 60 + shifted.getUTCMinutes();
  const interval = BLOCKED_INTERVALS.find(
    ({ start, end }) => minuteOfDay >= start && minuteOfDay < end,
  );
  if (!interval)
    return { allowed: true, reason: "outside_blocked_window", jst };

  const start = `${String(Math.floor(interval.start / 60)).padStart(2, "0")}:${String(interval.start % 60).padStart(2, "0")}`;
  const end = `${String(Math.floor(interval.end / 60)).padStart(2, "0")}:${String(interval.end % 60).padStart(2, "0")}`;
  return { allowed: false, reason: `blocked_window_${start}-${end}_JST`, jst };
}

function parseInstant(args) {
  if (args.length === 0) return new Date();
  if (args.length !== 2 || args[0] !== "--at")
    throw new Error("usage: node deploy-window.mjs [--at ISO_INSTANT]");
  return new Date(args[1]);
}

async function main() {
  const result = decideDeployWindow(parseInstant(process.argv.slice(2)));
  const outputPath = process.env.GITHUB_OUTPUT;
  if (!outputPath) throw new Error("GITHUB_OUTPUT is required");
  await appendFile(
    outputPath,
    `allowed=${result.allowed}\nreason=${result.reason}\njst=${result.jst}\n`,
  );
  console.log(
    `Deploy window ${result.allowed ? "allowed" : "blocked"} at ${result.jst}: ${result.reason}`,
  );
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1])
) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
