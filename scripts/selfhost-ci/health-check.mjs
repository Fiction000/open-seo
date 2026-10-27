import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export async function checkProduction({
  env = process.env,
  fetchImpl = fetch,
} = {}) {
  const id = env.CLOUDFLARE_ACCESS_CLIENT_ID;
  const secret = env.CLOUDFLARE_ACCESS_CLIENT_SECRET;
  if (!id || !secret)
    throw new Error("Production verification requires both Access credentials");
  let response;
  try {
    response = await fetchImpl("https://seo.katot.dev/api/health", {
      method: "GET",
      redirect: "manual",
      signal: AbortSignal.timeout(30000),
      headers: { "CF-Access-Client-Id": id, "CF-Access-Client-Secret": secret },
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
  const contentType = ["application/json", "text/html", "text/plain"].includes(
    mediaType,
  )
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
  if (response.status !== 200 || payload?.status !== "ok")
    throw new Error(
      `Production verification expected HTTP 200 with JSON status "ok"; status=${response.status}; cf-ray=${ray}; content-type=${contentType}; body=${bodyKind}; redirects are not followed`,
    );
  return "https://seo.katot.dev/api/health: HTTP 200, status ok without redirects";
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
