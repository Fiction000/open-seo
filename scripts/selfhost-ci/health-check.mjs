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
    response = await fetchImpl("https://seo.katot.dev/", {
      redirect: "manual",
      signal: AbortSignal.timeout(30000),
      headers: { "CF-Access-Client-Id": id, "CF-Access-Client-Secret": secret },
    });
  } catch {
    throw new Error(
      "Production verification request failed (details suppressed)",
    );
  }
  await response.body?.cancel();
  if (response.status !== 200)
    throw new Error(
      `Production verification expected HTTP 200, got ${response.status}; redirects are not followed`,
    );
  return "https://seo.katot.dev/: HTTP 200 without redirects";
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
