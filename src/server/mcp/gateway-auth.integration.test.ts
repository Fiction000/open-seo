/* eslint-disable max-lines -- integration coverage exercises real HTTP and SQL boundaries */
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
const google = vi.hoisted(() => ({
  gsc: { getPerformance: vi.fn(), inspectUrls: vi.fn() },
  reports: { runReport: vi.fn() },
  overview: { getOrganicOverview: vi.fn() },
  health: { getMeasurementHealth: vi.fn() },
  opportunities: { getOpportunities: vi.fn() },
}));
vi.mock("@/server/features/gsc/services/GscService", () => ({
  GscService: google.gsc,
}));
vi.mock("@/server/features/ga4/services/Ga4ReportingService", () => ({
  Ga4ReportingService: google.reports,
}));
vi.mock("@/server/features/ga4/services/Ga4OrganicOverviewService", () => ({
  Ga4OrganicOverviewService: google.overview,
}));
vi.mock("@/server/features/ga4/services/Ga4MeasurementHealthService", () => ({
  Ga4MeasurementHealthService: google.health,
}));
vi.mock("@/server/features/ga4/services/SearchOpportunityService", () => ({
  SearchOpportunityService: google.opportunities,
}));
vi.mock("@/server/features/google/oauth-config", () => ({
  hasGoogleOAuthConfig: vi.fn(async () => true),
}));

import { GscService } from "@/server/features/gsc/services/GscService";
import { Ga4ReportingService } from "@/server/features/ga4/services/Ga4ReportingService";
import { Ga4OrganicOverviewService } from "@/server/features/ga4/services/Ga4OrganicOverviewService";
import { Ga4MeasurementHealthService } from "@/server/features/ga4/services/Ga4MeasurementHealthService";
import { SearchOpportunityService } from "@/server/features/ga4/services/SearchOpportunityService";
import { makeGa4ReportResult } from "@/server/features/ga4/services/ga4-test-fixtures";

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
      ('shared-project-2', 'shared-workspace', 'Second project', 'second.test'),
      ('foreign-project', 'other-org', 'Foreign project', 'foreign.test');
  `);
  google.gsc.getPerformance.mockResolvedValue({
    siteUrl: "https://first.test/",
    request: {
      startDate: "2026-01-01",
      endDate: "2026-01-02",
      dimensions: ["query"],
      startRow: 0,
    },
    rows: [],
  });
  google.gsc.inspectUrls.mockResolvedValue({
    siteUrl: "https://first.test/",
    results: [],
  });
  google.reports.runReport.mockResolvedValue(makeGa4ReportResult());
  google.overview.getOrganicOverview.mockResolvedValue({
    status: "ok",
    source: {},
    request: {
      resolvedDateRange: { startDate: "2026-01-01", endDate: "2026-01-02" },
      previousDateRange: { startDate: "2025-12-30", endDate: "2025-12-31" },
      trend: "daily",
    },
    current: null,
    previous: null,
    comparison: {},
    trend: [],
    diagnostics: [],
    reportMetadata: {},
    warnings: [],
  });
  google.health.getMeasurementHealth.mockResolvedValue({
    status: "ok",
    source: {},
    summary: { webStreamCount: 0, keyEventCount: 0, issueCount: 0 },
    issues: [],
    webStreams: [],
    otherStreams: [],
    keyEvents: [],
    customDefinitions: { dimensions: [], metrics: [] },
  });
  google.opportunities.getOpportunities.mockResolvedValue({
    status: "ok",
    source: {},
    request: { dateRange: {} },
    rowCount: 0,
    totalCandidateRows: 0,
    rows: [],
    scoring: {},
    coverage: {},
    truncated: {},
    warnings: [],
    reportMetadata: {},
  });
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

async function handle(
  method: string,
  params: Record<string, unknown> = {},
  env = config,
  modern = false,
) {
  const request = new Request("https://seo.katot.dev/mcp", {
    method: "POST",
    headers: {
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
      "cf-access-jwt-assertion": await accessToken(),
      ...(modern
        ? {
            "Mcp-Method": method,
            ...(typeof params.name === "string"
              ? { "Mcp-Name": params.name }
              : {}),
          }
        : {}),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method,
      params: modern
        ? {
            ...params,
            _meta: {
              "io.modelcontextprotocol/protocolVersion": "2026-07-28",
              "io.modelcontextprotocol/clientCapabilities": {},
            },
          }
        : params,
    }),
  });
  return transport(request, "cloudflare_access", env, ctx);
}

async function rows(sql: string) {
  return (await client.execute(sql)).rows;
}

describe("OpenSEO shared-workspace MCP database integration", () => {
  it.each([false, true])(
    "returns valid success results for every allowlisted Google tool (modern=%s)",
    async (modern) => {
      const cases = [
        ["get_search_console_performance", {}, GscService.getPerformance],
        [
          "inspect_urls",
          { urls: ["https://first.test/"] },
          GscService.inspectUrls,
        ],
        [
          "get_google_analytics_organic_landing_pages",
          {},
          Ga4ReportingService.runReport,
        ],
        [
          "get_google_analytics_page_performance",
          {},
          Ga4ReportingService.runReport,
        ],
        ["get_google_analytics_key_events", {}, Ga4ReportingService.runReport],
        [
          "get_search_opportunities",
          {},
          SearchOpportunityService.getOpportunities,
        ],
        [
          "get_google_analytics_organic_overview",
          {},
          Ga4OrganicOverviewService.getOrganicOverview,
        ],
        [
          "get_google_analytics_traffic_acquisition",
          {},
          Ga4ReportingService.runReport,
        ],
        [
          "get_google_analytics_ecommerce_performance",
          {},
          Ga4ReportingService.runReport,
        ],
        ["get_google_analytics_site_search", {}, Ga4ReportingService.runReport],
        [
          "get_google_analytics_audience_breakdown",
          {},
          Ga4ReportingService.runReport,
        ],
        [
          "get_google_analytics_measurement_health",
          {},
          Ga4MeasurementHealthService.getMeasurementHealth,
        ],
      ] as const;
      for (const [name, args, service] of cases) {
        vi.mocked(service).mockClear();
        const response = await handle(
          "tools/call",
          { name, arguments: { projectId: "shared-project-1", ...args } },
          config,
          modern,
        );
        expect(
          response.status,
          `${name}: ${await response.clone().text()}`,
        ).toBe(200);
        const body = z
          .object({
            result: z.object({
              isError: z.boolean().optional(),
              structuredContent: z.record(z.string(), z.unknown()),
            }),
          })
          .parse(await response.json());
        expect(
          body.result?.isError,
          `${name}: ${JSON.stringify(body.result)}`,
        ).not.toBe(true);
        const content = body.result.structuredContent;
        expect(content.status === "ok" || content.ok === true).toBe(true);
        expect(service).toHaveBeenCalledTimes(1);
        if (service === Ga4ReportingService.runReport) {
          const expectedKind: Record<string, string> = {
            get_google_analytics_organic_landing_pages: "landing_pages",
            get_google_analytics_page_performance: "page_performance",
            get_google_analytics_key_events: "key_events",
            get_google_analytics_traffic_acquisition: "traffic_acquisition",
            get_google_analytics_ecommerce_performance: "ecommerce_performance",
            get_google_analytics_site_search: "site_search",
            get_google_analytics_audience_breakdown: "audience_breakdown",
          };
          expect(vi.mocked(service).mock.calls[0]?.[0]).toMatchObject({
            kind: expectedKind[name],
          });
        }
      }
    },
  );

  it.each([false, true])(
    "denies representative unallowlisted tools without writes (modern=%s)",
    async (modern) => {
      const before = await rows(
        "SELECT id, organization_id, name, domain FROM projects ORDER BY id",
      );
      for (const name of [
        "set_search_console_site",
        "set_google_analytics_property",
        "list_search_console_sites",
        "list_google_analytics_properties",
        "research_keywords",
        "get_domain_overview",
        "create_project",
        "run_site_audit",
        "run_rank_tracker",
        "delete_report",
        "save_keywords",
        "execute_sql",
      ]) {
        const response = await handle(
          "tools/call",
          { name, arguments: { projectId: "shared-project-1" } },
          config,
          modern,
        );
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({
          error: { code: -32602 },
        });
      }
      expect(
        await rows(
          "SELECT id, organization_id, name, domain FROM projects ORDER BY id",
        ),
      ).toEqual(before);
      expect(GscService.getPerformance).not.toHaveBeenCalled();
      expect(Ga4ReportingService.runReport).not.toHaveBeenCalled();
      expect(SearchOpportunityService.getOpportunities).not.toHaveBeenCalled();
    },
  );
  it("serves initialize, the shared gateway tool allowlist and SQL-backed projects with no members or writes", async () => {
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
    expect(listing.result.tools).toHaveLength(14);
    expect(new Set(listing.result.tools.map((tool) => tool.name))).toEqual(
      new Set([
        "whoami",
        "list_projects",
        "get_search_console_performance",
        "inspect_urls",
        "get_google_analytics_organic_landing_pages",
        "get_google_analytics_page_performance",
        "get_google_analytics_key_events",
        "get_search_opportunities",
        "get_google_analytics_organic_overview",
        "get_google_analytics_traffic_acquisition",
        "get_google_analytics_ecommerce_performance",
        "get_google_analytics_site_search",
        "get_google_analytics_audience_breakdown",
        "get_google_analytics_measurement_health",
      ]),
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

  it("denies allowed GSC and GA tools for a foreign project before provider fetch", async () => {
    for (const name of [
      "get_search_console_performance",
      "get_google_analytics_organic_overview",
    ]) {
      const response = await handle("tools/call", {
        name,
        arguments: { projectId: "foreign-project" },
      });
      expect(response.status).toBe(200);
      const body = z
        .object({
          result: z.object({
            isError: z.literal(true),
            content: z.array(
              z.object({ type: z.literal("text"), text: z.string() }),
            ),
          }),
        })
        .parse(await response.json());
      expect(body.result.content[0]?.text).toBe("NOT_FOUND");
    }
    expect(GscService.getPerformance).not.toHaveBeenCalled();
    expect(GscService.inspectUrls).not.toHaveBeenCalled();
    expect(Ga4ReportingService.runReport).not.toHaveBeenCalled();
    expect(Ga4OrganicOverviewService.getOrganicOverview).not.toHaveBeenCalled();
    expect(
      Ga4MeasurementHealthService.getMeasurementHealth,
    ).not.toHaveBeenCalled();
    expect(SearchOpportunityService.getOpportunities).not.toHaveBeenCalled();
    const requests = vi
      .mocked(fetch)
      .mock.calls.map(([input]) =>
        input instanceof Request
          ? input.url
          : input instanceof URL
            ? input.href
            : input,
      );
    expect(requests.every((url) => url.includes("/cdn-cgi/access/certs"))).toBe(
      true,
    );
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
