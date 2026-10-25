import { generateKeyPair, exportJWK, SignJWT } from "jose";
import { z } from "zod";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { handleSelfHostedOpenSeoMcpRequest } from "@/server/mcp/transport";
import { AuthRepository } from "@/server/auth/repositories/AuthRepository";
import { ProjectService } from "@/server/features/projects/services/ProjectService";

vi.mock("cloudflare:workers", () => ({ env: {}, waitUntil: vi.fn() }));
vi.mock("@/server/auth/repositories/AuthRepository", () => ({
  AuthRepository: { organizationExists: vi.fn() },
}));
vi.mock("@/server/features/projects/services/ProjectService", () => ({
  ProjectService: { listProjects: vi.fn() },
}));
vi.mock("@/server/lib/runtime-env", () => ({
  getOptionalEnvValue: vi.fn(async () => undefined),
  isHostedServerAuthMode: vi.fn(async () => false),
}));
vi.mock("@/server/mcp/instrumentation", () => ({
  instrumentMcpToolHandler: (
    _name: string,
    _schema: unknown,
    handler: unknown,
  ) => handler,
}));
vi.mock("@/middleware/ensure-user/cloudflareAccess", () => ({
  resolveCloudflareAccessContext: vi.fn(),
}));
vi.mock("@/middleware/ensure-user/delegated", () => ({
  resolveLocalNoAuthContext: vi.fn(),
}));

const teamDomain = "https://team.example.test";
const config = {
  AUTH_MODE: "cloudflare_access",
  TEAM_DOMAIN: teamDomain,
  MCP_GATEWAY_ENABLED: "true",
  MCP_GATEWAY_AUD: "gateway-audience",
  MCP_GATEWAY_CLIENT_ID: "gateway-client-id",
  MCP_GATEWAY_ORGANIZATION_ID: "shared-workspace",
};
const ctx: ExecutionContext = {
  waitUntil() {},
  passThroughOnException() {},
  props: {},
};
let privateKey: CryptoKey;
let publicJwk: JsonWebKey;

beforeAll(async () => {
  const pair = await generateKeyPair("RS256");
  privateKey = pair.privateKey;
  publicJwk = await exportJWK(pair.publicKey);
  Object.assign(publicJwk, {
    kid: "gateway-test-key",
    alg: "RS256",
    use: "sig",
  });
});

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ keys: [publicJwk] })),
  );
  vi.mocked(AuthRepository.organizationExists).mockResolvedValue(true);
  vi.mocked(ProjectService.listProjects).mockResolvedValue([]);
});

afterEach(() => vi.unstubAllGlobals());

async function accessToken(
  overrides: Record<string, unknown> = {},
  signingKey: CryptoKey = privateKey,
) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({
    aud: "gateway-audience",
    iss: teamDomain,
    iat: now,
    exp: now + 300,
    type: "app",
    common_name: "gateway-client-id",
    ...overrides,
  })
    .setProtectedHeader({ alg: "RS256", kid: "gateway-test-key" })
    .sign(signingKey);
}

function rpcRequest(method: string, params: unknown = {}, token?: string) {
  return new Request("https://seo.katot.dev/mcp", {
    method: "POST",
    headers: {
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
      ...(token ? { "cf-access-jwt-assertion": token } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
}

async function handle(
  method: string,
  params: unknown = {},
  token?: string,
  env = config,
) {
  return handleSelfHostedOpenSeoMcpRequest(
    rpcRequest(method, params, token),
    "cloudflare_access",
    env,
    ctx,
  );
}

describe("OpenSEO machine MCP HTTP authentication", () => {
  it("runs initialize, lists exactly two tools, and calls both free tools in the pinned org", async () => {
    const token = await accessToken();
    const initialized = await handle(
      "initialize",
      {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "gateway-test", version: "1" },
      },
      token,
    );
    expect(initialized.status).toBe(200);

    const listed = await handle("tools/list", {}, token);
    expect(listed.status).toBe(200);
    const { result: tools } = z
      .object({
        result: z.object({ tools: z.array(z.object({ name: z.string() })) }),
      })
      .parse(await listed.json());
    expect(tools.tools).toHaveLength(14);
    expect(tools.tools).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "list_projects" }),
        expect.objectContaining({ name: "whoami" }),
      ]),
    );

    const whoami = await handle(
      "tools/call",
      { name: "whoami", arguments: {} },
      token,
    );
    expect(whoami.status).toBe(200);
    const whoamiBody = z
      .object({
        result: z.object({
          structuredContent: z.record(z.string(), z.unknown()),
        }),
      })
      .parse(await whoami.json());
    expect(whoamiBody.result.structuredContent).toMatchObject({
      userEmail: "litellm-gateway@openseo.invalid",
      scopes: ["mcp:read"],
      mode: "self-hosted",
      creditsRemaining: null,
    });

    const projects = await handle(
      "tools/call",
      { name: "list_projects", arguments: {} },
      token,
    );
    expect(projects.status).toBe(200);
    const projectBody = z
      .object({
        result: z.object({
          structuredContent: z.object({ projects: z.array(z.unknown()) }),
        }),
      })
      .parse(await projects.json());
    expect(projectBody.result.structuredContent.projects).toEqual([]);
    expect(ProjectService.listProjects).toHaveBeenCalledWith(
      "shared-workspace",
    );
    expect(AuthRepository.organizationExists).toHaveBeenCalledWith(
      "shared-workspace",
    );

    const paid = await handle(
      "tools/call",
      { name: "create_project", arguments: { domain: "paid.test" } },
      token,
    );
    expect(paid.status).toBe(200);
    const paidBody = z
      .object({ error: z.object({ code: z.number() }).optional() })
      .parse(await paid.json());
    expect(paidBody.error?.code).toBe(-32602);
    for (const name of [
      "research_keywords",
      "create_project",
      "set_google_analytics_property",
      "run_site_audit",
      "run_rank_tracker",
      "delete_report",
      "not_a_real_tool",
    ]) {
      const denied = await handle(
        "tools/call",
        { name, arguments: { projectId: "shared-project-1" } },
        token,
      );
      expect(denied.status).toBe(200);
      expect(await denied.json()).toMatchObject({
        error: { code: -32602 },
      });
    }
  });

  it.each([
    ["missing bearer assertion", undefined, config, 401],
    [
      "disabled gateway",
      "valid",
      { ...config, MCP_GATEWAY_ENABLED: "false" },
      403,
    ],
    [
      "missing enabled config",
      "valid",
      { ...config, MCP_GATEWAY_AUD: "" },
      503,
    ],
  ])(
    "returns a controlled response for %s",
    async (_name, token, env, status) => {
      const bearer = token === "valid" ? await accessToken() : token;
      const response = await handle("tools/list", {}, bearer, env);
      expect(response.status).toBe(status);
      const body = await response.text();
      expect(body).not.toContain("stack");
      expect(body).not.toContain(bearer ?? "never-a-token");
    },
  );

  it.each([
    ["wrong audience", { aud: "wrong-audience" }, 403],
    ["wrong issuer", { iss: "https://other-team.example.test" }, 401],
    ["wrong common name", { common_name: "other-client" }, 403],
    ["wrong JWT type", { type: "user" }, 403],
    ["expired token", { exp: Math.floor(Date.now() / 1000) - 30 }, 401],
    ["missing iat", { iat: undefined }, 401],
    ["missing exp", { exp: undefined }, 401],
  ])("rejects %s with its contract status", async (_name, claims, status) => {
    const token = await accessToken(claims);
    const response = await handle("tools/list", {}, token);
    expect(response.status).toBe(status);
    expect(await response.text()).not.toContain(token);
  });

  it("returns a sanitized 401 for a bad signature and 500 for unexpected failures", async () => {
    const other = await generateKeyPair("RS256");
    const badSignature = await accessToken({}, other.privateKey);
    const rejected = await handle("tools/list", {}, badSignature);
    expect(rejected.status).toBe(401);
    expect(await rejected.text()).not.toContain(badSignature);

    vi.mocked(AuthRepository.organizationExists).mockRejectedValueOnce(
      new Error("database secret detail"),
    );
    const failed = await handle("tools/list", {}, await accessToken());
    expect(failed.status).toBe(500);
    expect(await failed.text()).not.toContain("database secret detail");
  });

  it("returns 503 when the JWKS endpoint cannot be reached", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("network failure details");
      }),
    );
    const response = await handle("tools/list", {}, await accessToken(), {
      ...config,
      TEAM_DOMAIN: "https://unavailable.example.test",
    });
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("network failure details");
  });

  it("does not leak machine requests through untrusted forwarded URL headers", async () => {
    const token = await accessToken();
    const request = new Request("https://seo.katot.dev/mcp", {
      method: "POST",
      headers: {
        Accept: "application/json, text/event-stream",
        "Content-Type": "application/json",
        "cf-access-jwt-assertion": token,
        "x-forwarded-host": "other.example.test",
        "x-forwarded-proto": "http",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    const response = await handleSelfHostedOpenSeoMcpRequest(
      request,
      "cloudflare_access",
      config,
      ctx,
    );
    expect(response.status).toBe(200);
  });
});
