import { createClient, type Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { z } from "zod";
import * as schema from "@/db/schema";
import type { handleSelfHostedOpenSeoMcpRequest } from "@/server/mcp/transport";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

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

const teamDomain = "https://team.example.test";
const sharedOrgId = "shared-workspace";
const config = {
  AUTH_MODE: "cloudflare_access",
  TEAM_DOMAIN: teamDomain,
  MCP_GATEWAY_ENABLED: "true",
  MCP_GATEWAY_AUD: "gateway-audience",
  MCP_GATEWAY_CLIENT_ID: "gateway-client-id",
  MCP_GATEWAY_ORGANIZATION_ID: sharedOrgId,
};
const ctx: ExecutionContext = {
  waitUntil() {},
  passThroughOnException() {},
  props: {},
};
let client: Client;
let transport: typeof handleSelfHostedOpenSeoMcpRequest;
let privateKey: CryptoKey;
let publicJwk: JsonWebKey;

beforeAll(async () => {
  client = createClient({ url: "file::memory:" });
  const testDb = drizzle(client, { schema });
  vi.doMock("@/db", () => ({ db: testDb }));
  vi.doMock("@/db/d1/client", () => ({ d1Db: testDb }));
  vi.doMock("@/db/pg/client", () => ({ pgDb: null }));
  await client.executeMultiple(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE organization (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      slug TEXT NOT NULL UNIQUE,
      logo TEXT,
      created_at INTEGER NOT NULL,
      metadata TEXT
    );
    CREATE TABLE user (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      email_verified INTEGER NOT NULL DEFAULT 0,
      image TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE member (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL REFERENCES organization(id),
      user_id TEXT NOT NULL REFERENCES user(id),
      role TEXT NOT NULL DEFAULT 'member',
      created_at INTEGER NOT NULL
    );
    CREATE TABLE projects (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL REFERENCES organization(id),
      name TEXT NOT NULL,
      domain TEXT,
      location_code INTEGER NOT NULL DEFAULT 2840,
      language_code TEXT NOT NULL DEFAULT 'en',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      archived_at TEXT,
      ai_research_keywords TEXT,
      indexnow_key TEXT
    );
    CREATE TRIGGER no_user_insert BEFORE INSERT ON user BEGIN
      SELECT RAISE(ABORT, 'user writes are prohibited in this test');
    END;
    CREATE TRIGGER no_user_update BEFORE UPDATE ON user BEGIN
      SELECT RAISE(ABORT, 'user writes are prohibited in this test');
    END;
    CREATE TRIGGER no_user_delete BEFORE DELETE ON user BEGIN
      SELECT RAISE(ABORT, 'user writes are prohibited in this test');
    END;
    CREATE TRIGGER no_member_insert BEFORE INSERT ON member BEGIN
      SELECT RAISE(ABORT, 'member writes are prohibited in this test');
    END;
    CREATE TRIGGER no_member_update BEFORE UPDATE ON member BEGIN
      SELECT RAISE(ABORT, 'member writes are prohibited in this test');
    END;
    CREATE TRIGGER no_member_delete BEFORE DELETE ON member BEGIN
      SELECT RAISE(ABORT, 'member writes are prohibited in this test');
    END;
  `);
  const pair = await generateKeyPair("RS256");
  privateKey = pair.privateKey;
  publicJwk = await exportJWK(pair.publicKey);
  Object.assign(publicJwk, {
    kid: "gateway-db-test-key",
    alg: "RS256",
    use: "sig",
  });
  ({ handleSelfHostedOpenSeoMcpRequest: transport } =
    await import("@/server/mcp/transport"));
});

afterAll(() => client.close());

beforeEach(async () => {
  await client.executeMultiple(`
    DELETE FROM projects;
    DELETE FROM organization;
    INSERT INTO organization (id, name, slug, created_at)
      VALUES ('shared-workspace', 'Shared workspace', 'shared-workspace', 0),
             ('other-org', 'Other organization', 'other-org', 0);
    INSERT INTO projects (id, organization_id, name, domain) VALUES
      ('shared-project-1', 'shared-workspace', 'First project', 'first.test'),
      ('shared-project-2', 'shared-workspace', 'Second project', 'second.test');
  `);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ keys: [publicJwk] })),
  );
});

afterEach(() => vi.unstubAllGlobals());

async function accessToken() {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({
    aud: "gateway-audience",
    iss: teamDomain,
    iat: now,
    exp: now + 300,
    type: "app",
    common_name: "gateway-client-id",
  })
    .setProtectedHeader({ alg: "RS256", kid: "gateway-db-test-key" })
    .sign(privateKey);
}

async function handle(method: string, params: unknown = {}, env = config) {
  const request = new Request("https://seo.katot.dev/mcp", {
    method: "POST",
    headers: {
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
      "cf-access-jwt-assertion": await accessToken(),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  return transport(request, "cloudflare_access", env, ctx);
}

async function rows(sql: string) {
  return (await client.execute(sql)).rows;
}

describe("OpenSEO shared-workspace MCP database integration", () => {
  it("serves initialize, exactly two tools and the two SQL-backed projects with no members or writes", async () => {
    const initialized = await handle("initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "gateway-db-test", version: "1" },
    });
    expect(initialized.status).toBe(200);
    const initializeBody = z
      .object({
        result: z.object({
          protocolVersion: z.string(),
          capabilities: z.record(z.string(), z.unknown()),
        }),
      })
      .parse(await initialized.json());
    expect(initializeBody.result.protocolVersion).toBe("2025-03-26");

    const listed = await handle("tools/list");
    expect(listed.status).toBe(200);
    const listing = z
      .object({
        result: z.object({ tools: z.array(z.object({ name: z.string() })) }),
      })
      .parse(await listed.json());
    expect(listing.result.tools).toHaveLength(2);
    expect(new Set(listing.result.tools.map((tool) => tool.name))).toEqual(
      new Set(["list_projects", "whoami"]),
    );

    const projects = await handle("tools/call", {
      name: "list_projects",
      arguments: {},
    });
    expect(projects.status).toBe(200);
    expect(await projects.json()).toMatchObject({
      result: {
        structuredContent: {
          projects: [
            expect.objectContaining({ id: "shared-project-2" }),
            expect.objectContaining({ id: "shared-project-1" }),
          ],
        },
      },
    });
    expect(
      await rows(
        "SELECT count(*) AS n FROM organization WHERE id = 'shared-workspace'",
      ),
    ).toEqual([expect.objectContaining({ n: 1 })]);
    expect(
      await rows(
        "SELECT count(*) AS n FROM projects WHERE organization_id = 'shared-workspace'",
      ),
    ).toEqual([expect.objectContaining({ n: 2 })]);
    expect(await rows("SELECT count(*) AS n FROM member")).toEqual([
      expect.objectContaining({ n: 0 }),
    ]);
    expect(await rows("SELECT count(*) AS n FROM user")).toEqual([
      expect.objectContaining({ n: 0 }),
    ]);
  });

  it.each([
    ["configured organization is another existing organization", "other-org"],
    ["configured organization does not exist", "missing-org"],
  ])("denies when %s", async (_case, organizationId) => {
    const response = await handle(
      "tools/list",
      {},
      {
        ...config,
        MCP_GATEWAY_ORGANIZATION_ID: organizationId,
      },
    );
    expect(response.status).toBe(403);
    expect(await rows("SELECT count(*) AS n FROM member")).toEqual([
      expect.objectContaining({ n: 0 }),
    ]);
    expect(await rows("SELECT count(*) AS n FROM user")).toEqual([
      expect.objectContaining({ n: 0 }),
    ]);
  });

  it("denies when the pinned shared-workspace organization is absent from SQL", async () => {
    await client.executeMultiple(`
      DELETE FROM projects WHERE organization_id = 'shared-workspace';
      DELETE FROM organization WHERE id = 'shared-workspace';
    `);

    const response = await handle("tools/list");
    expect(response.status).toBe(403);
    expect(await rows("SELECT count(*) AS n FROM member")).toEqual([
      expect.objectContaining({ n: 0 }),
    ]);
    expect(await rows("SELECT count(*) AS n FROM user")).toEqual([
      expect.objectContaining({ n: 0 }),
    ]);
  });
});
