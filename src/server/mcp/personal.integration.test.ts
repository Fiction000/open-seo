/* eslint-disable max-lines -- exercises signed auth, HTTP MCP dispatch, and SQLite persistence */
import { createClient, type Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { readFileSync } from "node:fs";
import {
  beforeAll,
  afterAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import * as schema from "@/db/schema";
import type { handlePersonalAutomationMcpRequest } from "@/server/mcp/transport";

vi.mock("cloudflare:workers", () => ({ env: {}, waitUntil: vi.fn() }));
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
const projectIds = [
  "123e4567-e89b-42d3-a456-426614174000",
  "123e4567-e89b-42d3-a456-426614174001",
] as const;
const env = {
  AUTH_MODE: "cloudflare_access",
  TEAM_DOMAIN: "https://personal-test.cloudflareaccess.com",
  MCP_GATEWAY_AUD: "shared-aud",
  MCP_GATEWAY_CLIENT_ID: "shared-client",
  MCP_GATEWAY_ORGANIZATION_ID: "shared-workspace",
  MCP_PERSONAL_ENABLED: "true",
  MCP_PERSONAL_AUD: "personal-aud",
  MCP_PERSONAL_CLIENT_ID: "cf-access-client-9812",
  MCP_PERSONAL_ORGANIZATION_ID: "shared-workspace",
  MCP_PERSONAL_PROJECT_IDS: JSON.stringify(projectIds),
};
const ctx: ExecutionContext = {
  waitUntil() {},
  passThroughOnException() {},
  props: {},
};
let client: Client;
let privateKey: CryptoKey;
let publicJwk: JsonWebKey;
let transport: typeof handlePersonalAutomationMcpRequest;

beforeAll(async () => {
  client = createClient({ url: "file::memory:" });
  const testDb = drizzle(client, { schema });
  vi.doMock("@/db", () => ({ db: testDb }));
  vi.doMock("@/db/d1/client", () => ({ d1Db: testDb }));
  vi.doMock("@/db/pg/client", () => ({ pgDb: null }));
  const contextMigration = readFileSync(
    "drizzle/sqlite/0042_project_memory.sql",
    "utf8",
  )
    .split("--> statement-breakpoint")
    .filter((sql) => !sql.includes("DROP TABLE"))
    .join("\n");
  await client.executeMultiple(`PRAGMA foreign_keys=ON;
    CREATE TABLE organization (id TEXT PRIMARY KEY, name TEXT NOT NULL, slug TEXT NOT NULL UNIQUE, logo TEXT, created_at INTEGER NOT NULL, metadata TEXT);
    CREATE TABLE projects (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, name TEXT NOT NULL, domain TEXT, location_code INTEGER NOT NULL DEFAULT 2840, language_code TEXT NOT NULL DEFAULT 'en', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, archived_at TEXT, ai_research_keywords TEXT, indexnow_key TEXT);
    CREATE TABLE user (id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE, email_verified INTEGER NOT NULL DEFAULT 0, image TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE member (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, user_id TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'member', created_at INTEGER NOT NULL);
    CREATE TRIGGER no_user_write BEFORE INSERT ON user BEGIN SELECT RAISE(ABORT, 'user writes forbidden'); END;
    CREATE TRIGGER no_member_write BEFORE INSERT ON member BEGIN SELECT RAISE(ABORT, 'member writes forbidden'); END;
    CREATE TABLE report_templates (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, name TEXT NOT NULL, description TEXT NOT NULL, instructions TEXT NOT NULL, created_by TEXT NOT NULL, created_by_user_id TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
    ${contextMigration}`);
  const pair = await generateKeyPair("RS256");
  privateKey = pair.privateKey;
  publicJwk = await exportJWK(pair.publicKey);
  Object.assign(publicJwk, {
    kid: "personal-test-key",
    alg: "RS256",
    use: "sig",
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ keys: [publicJwk] })),
  );
  const { createOpenSeoMcpServer } = await import("@/server/mcp/server");
  const { createWorkersOAuthMcpProps } = await import("@/server/mcp/context");
  createOpenSeoMcpServer(
    createWorkersOAuthMcpProps({
      userId: "ordinary-test-user",
      userEmail: "ordinary@example.invalid",
      organizationId: "shared-workspace",
      baseUrl: "https://seo.katot.dev",
    }),
  ); // Warm the ordinary full update schema in this isolate before personal HTTP initialization.
  ({ handlePersonalAutomationMcpRequest: transport } =
    await import("@/server/mcp/transport"));
});
afterAll(() => {
  vi.unstubAllGlobals();
  client.close();
});
beforeEach(async () => {
  await client.executeMultiple(
    `DELETE FROM project_key_pages; DELETE FROM project_competitors; DELETE FROM project_context_sections; DELETE FROM projects; DELETE FROM organization; INSERT INTO organization(id,name,slug,created_at) VALUES ('shared-workspace','Shared','shared-workspace',0),('other-org','Other','other-org',0); INSERT INTO projects(id,organization_id,name) VALUES ('${projectIds[0]}','shared-workspace','First'),('${projectIds[1]}','shared-workspace','Second'),('123e4567-e89b-42d3-a456-426614174002','shared-workspace','Third'),('123e4567-e89b-42d3-a456-426614174003','other-org','Foreign');`,
  );
});
async function token(overrides: Record<string, unknown> = {}) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({
    aud: "personal-aud",
    iss: env.TEAM_DOMAIN,
    iat: now,
    exp: now + 300,
    type: "app",
    common_name: env.MCP_PERSONAL_CLIENT_ID,
    ...overrides,
  })
    .setProtectedHeader({ alg: "RS256", kid: "personal-test-key" })
    .sign(privateKey);
}
async function request(
  method: string,
  params: Record<string, unknown> = {},
  opts: {
    token?: string;
    url?: string;
    methodHttp?: string;
    headers?: Record<string, string>;
  } = {},
) {
  const jwt = opts.token ?? (await token());
  return transport(
    new Request(opts.url ?? "https://seo.katot.dev/mcp/personal", {
      method: opts.methodHttp ?? "POST",
      headers: {
        Accept: "application/json, text/event-stream",
        "Content-Type": "application/json",
        "cf-access-jwt-assertion": jwt,
        ...opts.headers,
      },
      body:
        (opts.methodHttp ?? "POST") === "GET"
          ? undefined
          : JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    }),
    env,
    ctx,
  );
}
async function call(name: string, args: Record<string, unknown> = {}) {
  return request("tools/call", { name, arguments: args });
}
async function result(response: Response) {
  const json: {
    result?: {
      isError?: boolean;
      structuredContent?: Record<string, unknown>;
      tools?: Array<{ name: string }>;
    };
    error?: unknown;
  } = await response.json();
  return json;
}

describe("personal MCP HTTP and SQLite acceptance", () => {
  it("initializes, registers exactly four tools, and exposes only the configured two projects", async () => {
    expect(
      (
        await request("initialize", {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "integration", version: "1" },
        })
      ).status,
    ).toBe(200);
    const listing = await result(await request("tools/list"));
    expect(new Set(listing.result?.tools?.map((tool) => tool.name))).toEqual(
      new Set([
        "get_project_context",
        "list_projects",
        "update_project_context",
        "whoami",
      ]),
    );
    expect(
      (await result(await call("whoami"))).result?.structuredContent,
    ).toMatchObject({});
    const projects = await result(await call("list_projects"));
    expect(JSON.stringify(projects)).toContain(projectIds[0]);
    expect(JSON.stringify(projects)).toContain(projectIds[1]);
    expect(JSON.stringify(projects)).not.toContain(
      "123e4567-e89b-42d3-a456-426614174002",
    );
    expect(JSON.stringify(projects)).not.toContain(
      "123e4567-e89b-42d3-a456-426614174003",
    );
  });
  it("persists safe section/custom/competitor/key-page upserts, denies cross-project and unknown tools", async () => {
    const updates = [
      { section: "business_overview", content: "Allowed overview" },
      {
        customSection: "integration-notes",
        title: "Notes",
        content: "Allowed custom",
      },
      { addCompetitors: [{ domain: "rival.example.com", name: "Rival" }] },
      { addKeyPages: [{ url: "https://example.com/guide", role: "hub" }] },
    ];
    const response = await call("update_project_context", {
      projectId: projectIds[0],
      updates,
    });
    expect(response.status).toBe(200);
    const readback = await result(
      await call("get_project_context", { projectId: projectIds[0] }),
    );
    expect(JSON.stringify(readback)).toContain("Allowed overview");
    expect(JSON.stringify(readback)).toContain("Allowed custom");
    expect(JSON.stringify(readback)).toContain("rival.example.com");
    expect(JSON.stringify(readback)).toContain("https://example.com/guide");
    const secondUpdate = await call("update_project_context", {
      projectId: projectIds[1],
      updates,
    });
    expect((await result(secondUpdate)).result?.isError).not.toBe(true);
    const secondReadback = await result(
      await call("get_project_context", { projectId: projectIds[1] }),
    );
    expect(JSON.stringify(secondReadback)).toContain("Allowed overview");
    expect(JSON.stringify(secondReadback)).toContain("rival.example.com");
    const before = await client.execute(
      "SELECT (SELECT count(*) FROM project_context_sections) sections, (SELECT count(*) FROM project_competitors) competitors, (SELECT count(*) FROM project_key_pages) pages",
    );
    for (const name of [
      "research_keywords",
      "run_rank_tracker",
      "delete_report",
      "set_google_analytics_property",
      "get_search_console_performance",
      "run_site_audit",
    ]) {
      const denied = await result(await call(name, {}));
      expect(denied.error !== undefined || denied.result?.isError).toBe(true);
    }
    const thirdProjectRead = await result(
      await call("get_project_context", {
        projectId: "123e4567-e89b-42d3-a456-426614174002",
      }),
    );
    expect(thirdProjectRead.result?.isError).toBe(true);
    const thirdProjectWrite = await result(
      await call("update_project_context", {
        projectId: "123e4567-e89b-42d3-a456-426614174002",
        updates,
      }),
    );
    expect(thirdProjectWrite.result?.isError).toBe(true);
    expect(
      await client.execute(
        "SELECT (SELECT count(*) FROM project_context_sections) sections, (SELECT count(*) FROM project_competitors) competitors, (SELECT count(*) FROM project_key_pages) pages",
      ),
    ).toEqual(before);
  });
  it("fails closed for invalid credentials and unsafe update shapes", async () => {
    const invalid = await token({ common_name: "wrong-client" });
    expect((await request("tools/list", {}, { token: invalid })).status).toBe(
      403,
    );
    expect(
      (
        await request(
          "tools/list",
          {},
          { token: await token({ type: "human" }) },
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await request(
          "tools/list",
          {},
          { token: await token({ aud: "wrong-audience" }) },
        )
      ).status,
    ).toBe(401);
    expect(
      (
        await request(
          "tools/list",
          {},
          { token: await token({ iss: "https://wrong.example" }) },
        )
      ).status,
    ).toBe(401);
    expect(
      (
        await request(
          "tools/list",
          {},
          { token: await token({ exp: Math.floor(Date.now() / 1000) - 30 }) },
        )
      ).status,
    ).toBe(401);
    const attacker = await generateKeyPair("RS256");
    const badSignature = await new SignJWT({
      aud: "personal-aud",
      iss: env.TEAM_DOMAIN,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 300,
      type: "app",
      common_name: env.MCP_PERSONAL_CLIENT_ID,
    })
      .setProtectedHeader({ alg: "RS256", kid: "personal-test-key" })
      .sign(attacker.privateKey);
    expect(
      (await request("tools/list", {}, { token: badSignature })).status,
    ).toBe(401);
    const before = await client.execute(
      "SELECT count(*) AS n FROM project_context_sections",
    );
    const attempts = [
      [{ section: "current_goal", content: "" }],
      [{ section: "current_goal", content: "safe", appendResearchLog: true }],
      [{ deleteCustomSection: "x" }],
      [
        { addCompetitors: [{ domain: "rival.example" }] },
        { removeCompetitors: ["rival.example"] },
      ],
      [
        { customSection: "x", title: "X", content: "y" },
        { appendResearchLog: { title: "paid" } },
      ],
      [
        { addKeyPages: [{ url: "https://example.test" }] },
        { reportTemplates: [] },
      ],
    ];
    for (const updates of attempts) {
      const rejected = await result(
        await call("update_project_context", {
          projectId: projectIds[0],
          updates,
        }),
      );
      expect(rejected.result?.isError).toBe(true);
    }
    expect(
      await client.execute(
        "SELECT count(*) AS n FROM project_context_sections",
      ),
    ).toEqual(before);
    expect(
      await client.execute("SELECT count(*) AS n FROM project_research_log"),
    ).toMatchObject({ rows: [{ n: 0 }] });
  });
  it("rejects raw route, method, forwarded-host bypass, and malformed or colliding bindings", async () => {
    expect(
      (
        await request(
          "tools/list",
          {},
          { url: "https://seo.katot.dev/mcp?x=1" },
        )
      ).status,
    ).toBe(403);
    expect(
      (await request("tools/list", {}, { methodHttp: "GET" })).status,
    ).toBe(403);
    expect(
      (
        await request(
          "tools/list",
          {},
          {
            headers: { "x-forwarded-host": "seo.katot.dev" },
            url: "https://evil.test/mcp/personal",
          },
        )
      ).status,
    ).toBe(403);
    for (const bad of [
      { ...env, MCP_PERSONAL_PROJECT_IDS: "not-json" },
      { ...env, MCP_PERSONAL_AUD: env.MCP_GATEWAY_AUD },
      { ...env, MCP_PERSONAL_CLIENT_ID: env.MCP_GATEWAY_CLIENT_ID },
    ]) {
      const response = await transport(
        new Request("https://seo.katot.dev/mcp/personal", {
          method: "POST",
          headers: { "cf-access-jwt-assertion": await token() },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
        }),
        bad,
        ctx,
      );
      expect(response.status).toBe(503);
    }
  });
});
