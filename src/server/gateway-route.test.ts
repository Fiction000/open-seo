import { describe, expect, it, vi } from "vitest";
import worker from "@/server.ts";

const { transportSpy, downloadSpy, assetsSpy } = vi.hoisted(() => ({
  transportSpy: vi.fn(async () => new Response("mcp", { status: 200 })),
  downloadSpy: vi.fn(async () => new Response("download", { status: 200 })),
  assetsSpy: vi.fn(async () => new Response("asset", { status: 200 })),
}));

vi.mock("@tanstack/react-start/server", () => ({
  createStartHandler: () => async () => new Response("app"),
  defaultStreamHandler: vi.fn(),
}));
vi.mock("agents", () => ({ routeAgentRequest: vi.fn(async () => null) }));
vi.mock("@/middleware/ensure-user/resolve", () => ({
  resolveUserContextFromHeaders: vi.fn(),
}));
vi.mock("@/server/features/projects/repositories/ProjectRepository", () => ({
  ProjectRepository: { getProjectForOrganization: vi.fn() },
}));
vi.mock("@/server/features/sam/SamSessionRepository", () => ({
  SamSessionRepository: { getActiveSession: vi.fn() },
}));
vi.mock("@/server/features/rank-tracking/services/scheduledRankChecks", () => ({
  runScheduledRankChecks: vi.fn(),
}));
vi.mock("@/server/features/audit/services/auditReconciler", () => ({
  reconcileStaleAudits: vi.fn(),
}));
vi.mock("@/server/features/audit/services/firstAuditEmails", () => ({
  sendFirstAuditEmails: vi.fn(),
}));
vi.mock("@/server/billing/subscription", () => ({
  getOrCreateOrganizationCustomer: vi.fn(),
}));
vi.mock("@/server/lib/runtime-env", () => ({
  isHostedServerAuthMode: vi.fn(async () => false),
}));
vi.mock("@/lib/auth-mode", () => ({
  getAuthMode: (value: string | undefined) => value ?? "cloudflare_access",
  isHostedAuthMode: (value: string) => value === "hosted",
}));
vi.mock("@/server/mcp/oauth-provider", () => ({
  createOpenSeoOAuthProvider: () => ({
    fetch: vi.fn(),
    purgeExpiredData: vi.fn(),
  }),
}));
vi.mock("@/server/mcp/public-origin", () => ({
  requestWithPublicOrigin: (request: Request) => request,
}));
vi.mock("@/server/auth/repositories/AuthRepository", () => ({
  AuthRepository: { getOrganizationOwner: vi.fn() },
}));
vi.mock("@/db", () => ({
  withPgClient: (callback: () => unknown) => callback(),
}));
vi.mock("@/server/billing/autumn-webhook", () => ({
  AUTUMN_WEBHOOK_PATH: "/api/autumn/webhook",
  handleAutumnWebhookRequest: vi.fn(),
}));
vi.mock("@/server/referrals/dub", () => ({
  sweepDubReferredOrganizations: vi.fn(),
}));
vi.mock("@/server/lib/self-host-telemetry", () => ({
  maybeSendSelfHostHeartbeat: vi.fn(async () => undefined),
}));
vi.mock("@/server/gdpr/storage-erasure", () => ({
  handleGdprStorageErasure: vi.fn(async () => new Response("gdpr")),
}));
vi.mock("@/shared/gdpr-erasure", () => ({
  GDPR_STORAGE_ERASURE_PATH: "/api/gdpr/erase",
}));
vi.mock("@/server/features/ai-visibility/services/aiVisibilityExport", () => ({
  handleAiVisibilityDownload: downloadSpy,
}));
vi.mock("@/server/mcp/transport", () => ({
  handleAuthenticatedOpenSeoMcpRequest: vi.fn(),
  handleSelfHostedOpenSeoMcpRequest: transportSpy,
}));
vi.mock("@/server/workflows/RankCheckWorkflow", () => ({
  RankCheckWorkflow: vi.fn(),
}));
vi.mock("@/server/workflows/AiVisibilityWorkflow", () => ({
  AiVisibilityWorkflow: vi.fn(),
}));
vi.mock("@/server/workflows/LocalRankWorkflow", () => ({
  LocalRankWorkflow: vi.fn(),
}));
vi.mock("@/server/features/onboarding/RetainedOnboardingChatAgent", () => ({
  OnboardingChatAgent: vi.fn(),
}));
vi.mock("@/server/features/sam/SamChatAgent", () => ({
  SamChatAgent: vi.fn(),
}));

const ctx: ExecutionContext = {
  waitUntil() {},
  passThroughOnException() {},
  props: {},
};
const env = { AUTH_MODE: "cloudflare_access", ASSETS: { fetch: assetsSpy } };

const encodeTokenPart = (value: string) =>
  btoa(value).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");

async function fetchWorker(request: Request) {
  const response: unknown = await Reflect.apply(worker.fetch, worker, [
    request,
    env,
    ctx,
  ]);
  if (!(response instanceof Response)) {
    throw new Error("Worker fetch did not return a Response");
  }
  return response;
}

function serviceTokenHint(commonName: string | null = "gateway-client") {
  return `${encodeTokenPart(JSON.stringify({ alg: "none" }))}.${encodeTokenPart(
    JSON.stringify({
      type: "app",
      sub: "",
      ...(commonName === null ? {} : { common_name: commonName }),
    }),
  )}.untrusted`;
}

function candidateRequest(
  url: string,
  headers: Record<string, string> = {},
  token = serviceTokenHint(),
) {
  return new Request(url, {
    headers: { "cf-access-jwt-assertion": token, ...headers },
  });
}

describe("Worker gateway routing boundary", () => {
  it("blocks machine candidates before early handlers, including path and origin lookalikes", async () => {
    const early = await fetchWorker(
      candidateRequest("https://seo.katot.dev/api/ai-visibility/download"),
    );
    expect(early.status).toBe(403);
    expect(downloadSpy).not.toHaveBeenCalled();

    for (const request of [
      candidateRequest(
        "https://seo.katot.dev/api/ai-visibility/download",
        {},
        serviceTokenHint(null),
      ),
      candidateRequest("https://seo.katot.dev/mcp/"),
      candidateRequest("https://old-worker.example/mcp"),
      candidateRequest("http://seo.katot.dev/mcp"),
      candidateRequest("https://seo.katot.dev:8443/mcp"),
      candidateRequest("https://old-worker.example/api/gdpr/erase", {
        "x-forwarded-host": "seo.katot.dev",
        "x-forwarded-proto": "https",
      }),
    ]) {
      const response = await fetchWorker(request);
      expect(response.status).toBe(403);
    }
  });

  it("routes the exact HTTPS machine endpoint and leaves human early routes unchanged", async () => {
    const gateway = await fetchWorker(
      candidateRequest("https://seo.katot.dev/mcp"),
    );
    expect(gateway.status).toBe(200);
    expect(transportSpy).toHaveBeenCalledWith(
      expect.objectContaining({ url: "https://seo.katot.dev/mcp" }),
      "cloudflare_access",
      env,
      ctx,
    );

    const human = await fetchWorker(
      candidateRequest(
        "https://seo.katot.dev/api/ai-visibility/download",
        {},
        `${encodeTokenPart(JSON.stringify({ alg: "RS256" }))}.${encodeTokenPart(
          JSON.stringify({
            type: "app",
            sub: "human-user",
            email: "human@example.test",
            aud: ["owner-audience"],
          }),
        )}.untrusted`,
      ),
    );
    expect(human.status).toBe(200);
    expect(downloadSpy).toHaveBeenCalled();
  });

  it("converts unexpected gateway-handler failures to a sanitized HTTP response", async () => {
    transportSpy.mockRejectedValueOnce(new Error("private internal details"));
    const response = await fetchWorker(
      candidateRequest("https://seo.katot.dev/mcp"),
    );
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain("private internal details");
  });

  it("runs bounded self-host asset paths through the Worker before serving assets", async () => {
    const candidate = await fetchWorker(
      candidateRequest("https://seo.katot.dev/assets/app.js"),
    );
    expect(candidate.status).toBe(403);
    expect(assetsSpy).not.toHaveBeenCalled();

    const human = await fetchWorker(
      new Request("https://seo.katot.dev/assets/app.js"),
    );
    expect(human.status).toBe(200);
    expect(await human.text()).toBe("asset");
    expect(assetsSpy).toHaveBeenCalledOnce();
  });
});
