import { resolve } from "node:path";
import { setTimeout } from "node:timers/promises";
import { fileURLToPath } from "node:url";

export async function checkProduction({
  env = process.env,
  fetchImpl = fetch,
  sleepImpl = setTimeout,
  logImpl = console.log,
} = {}) {
  const id = env.CLOUDFLARE_ACCESS_CLIENT_ID;
  const secret = env.CLOUDFLARE_ACCESS_CLIENT_SECRET;
  if (!id || !secret)
    throw new Error("Production verification requires both Access credentials");
  const signal = AbortSignal.timeout(30000);
  for (let attempt = 1; attempt <= 6; attempt++) {
    let response;
    try {
      signal.throwIfAborted();
      response = await fetchImpl("https://seo.katot.dev/api/health", {
        method: "GET",
        redirect: "manual",
        signal,
        headers: {
          "CF-Access-Client-Id": id,
          "CF-Access-Client-Secret": secret,
        },
      });
    } catch {
      throw new Error(
        "Production verification request failed (details suppressed)",
      );
    }
    const rawRay = response.headers.get("cf-ray") ?? "";
    const ray =
      /^[a-f0-9]{16}-[a-z]{3}$/i.test(rawRay) &&
      ![id, secret].some((value) => rawRay.includes(value))
        ? rawRay
        : "unavailable";
    const mediaType = response.headers
      .get("content-type")
      ?.split(";")[0]
      .trim()
      .toLowerCase();
    const contentType = [
      "application/json",
      "text/html",
      "text/plain",
    ].includes(mediaType)
      ? mediaType
      : "other-or-missing";
    let bodyKind = "unreadable";
    let payload;
    try {
      const body = await response.text();
      try {
        payload = JSON.parse(body);
        bodyKind = payload?.error === "forbidden" ? "app-forbidden" : "json";
      } catch {
        bodyKind = /cloudflare access|cloudflareaccess\.com/i.test(body)
          ? "access-page"
          : contentType === "text/html"
            ? "html-page"
            : "other";
      }
    } catch {
      // Body errors can contain request credentials, so only emit a fixed label.
    }
    const diagnostic = `status=${response.status}; cf-ray=${ray}; content-type=${contentType}; body=${bodyKind}`;
    logImpl(diagnostic);
    if (response.status === 200 && payload?.status === "ok")
      return "https://seo.katot.dev/api/health: HTTP 200, status ok without redirects";
    if (
      attempt === 6 ||
      bodyKind === "unreadable" ||
      !(
        response.status === 403 ||
        (response.status >= 500 && response.status <= 599)
      )
    )
      throw new Error(
        `Production verification expected HTTP 200 with JSON status "ok"; ${diagnostic}; redirects are not followed`,
      );
    try {
      await sleepImpl(3000, undefined, { signal });
    } catch {
      throw new Error(
        "Production verification deadline exceeded (details suppressed)",
      );
    }
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  checkProduction()
    .then(console.log)
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
}
