import { describe, expect, it, vi } from "vitest";
import {
  isGrowthAutomationCandidate,
  resolveGrowthAutomationIdentity,
} from "./growth-auth";

vi.mock("cloudflare:workers", () => ({ env: {} }));
vi.mock("@/server/auth/repositories/AuthRepository", () => ({
  AuthRepository: {},
}));

function selectorToken(claims: Record<string, unknown>) {
  return `x.${btoa(JSON.stringify(claims)).replace(/=/g, "")}.x`;
}

const request = (url = "https://seo.katot.dev/mcp/growth", method = "POST") =>
  new Request(url, {
    method,
    headers: { "cf-access-jwt-assertion": "not-a-token" },
  });

const validConfig = {
  AUTH_MODE: "cloudflare_access",
  TEAM_DOMAIN: "https://team.example.cloudflareaccess.com",
  MCP_GATEWAY_AUD: "shared-audience",
  MCP_GATEWAY_CLIENT_ID: "shared-client",
  MCP_PERSONAL_AUD: "personal-audience",
  MCP_PERSONAL_CLIENT_ID: "personal-client",
  MCP_GROWTH_ENABLED: "true",
  MCP_GROWTH_AUD: "growth-audience",
  MCP_GROWTH_CLIENT_ID: "cf-access-automation-client-7f3a",
  MCP_GROWTH_ORGANIZATION_ID: "shared-workspace",
  MCP_GROWTH_PROJECT_IDS: JSON.stringify([
    "123e4567-e89b-42d3-a456-426614174000",
    "123e4567-e89b-42d3-a456-426614174001",
  ]),
};

describe("growth automation auth boundary", () => {
  it("never allows a tool that saves, starts, schedules, tracks, or deletes", async () => {
    const { GROWTH_MCP_ALLOWED_TOOLS } = await import("./growth-auth");
    const forbidden = [
      "update_project_context",
      "save_ai_visibility_tracker",
      "complete_ai_research_setup",
      "set_ai_visibility_schedule",
      "run_ai_visibility_check",
      "explore_prompt",
      "research_project_website",
      "save_project_website_setup",
      "create_project",
      "create_rank_tracker",
      "create_gateway_rank_tracker",
      "run_rank_tracker",
      "add_rank_tracking_keywords",
      "run_site_audit",
      "delete_site_audit",
      "save_report",
      "delete_report",
      "set_report_sharing",
      "save_keywords",
      "remove_saved_keywords",
      "set_search_console_site",
      "set_google_analytics_property",
      "submit_indexnow_urls",
      "get_local_rank_grid",
    ];
    for (const name of forbidden)
      expect(GROWTH_MCP_ALLOWED_TOOLS as readonly string[]).not.toContain(name);
    expect(new Set(GROWTH_MCP_ALLOWED_TOOLS).size).toBe(
      GROWTH_MCP_ALLOWED_TOOLS.length,
    );
  });

  it("leaves the shared machine gateway allowlist unchanged", async () => {
    const { MCP_GATEWAY_ALLOWED_TOOLS } = await import("./context");
    expect([...MCP_GATEWAY_ALLOWED_TOOLS]).toEqual([
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
      "get_dataforseo_balance",
      "create_gateway_rank_tracker",
    ]);
  });

  it("selects only tokens matching a valid enabled, non-colliding personal config", () => {
    const req = (claims: Record<string, unknown>) =>
      new Request("https://seo.katot.dev/mcp", {
        headers: { "cf-access-jwt-assertion": selectorToken(claims) },
      });
    const personal = req({
      aud: "growth-audience",
      common_name: validConfig.MCP_GROWTH_CLIENT_ID,
    });
    expect(isGrowthAutomationCandidate(personal, validConfig)).toBe(true);
    for (const bad of [
      { ...validConfig, MCP_GROWTH_ENABLED: "false" },
      { ...validConfig, MCP_GROWTH_AUD: "shared-audience" },
      { ...validConfig, MCP_GROWTH_CLIENT_ID: "shared-client" },
      { ...validConfig, MCP_GROWTH_AUD: "personal-audience" },
      { ...validConfig, MCP_GROWTH_CLIENT_ID: "personal-client" },
      { ...validConfig, MCP_GROWTH_PROJECT_IDS: "[]" },
      { ...validConfig, POLICY_AUD: "growth-audience" },
      { ...validConfig, MCP_GROWTH_PROJECT_IDS: "bad" },
      { ...validConfig, MCP_GROWTH_AUD: 42 },
    ])
      expect(isGrowthAutomationCandidate(personal, bad)).toBe(false);
    expect(
      isGrowthAutomationCandidate(
        req({ aud: "other", common_name: "human" }),
        validConfig,
      ),
    ).toBe(false);
  });

  it("fails closed when enabled configuration contains non-string bindings", async () => {
    await expect(
      resolveGrowthAutomationIdentity(request(), {
        ...validConfig,
        TEAM_DOMAIN: 42,
      }),
    ).rejects.toMatchObject({ status: 503 });
  });

  it("fails closed when disabled or bindings are missing", async () => {
    await expect(
      resolveGrowthAutomationIdentity(request(), {}),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      resolveGrowthAutomationIdentity(request(), {
        ...validConfig,
        MCP_GROWTH_ENABLED: "true",
        MCP_GROWTH_AUD: "",
      }),
    ).rejects.toMatchObject({ status: 503 });
  });

  it("rejects colliding identity and non-exact project configuration before JWKS access", async () => {
    await expect(
      resolveGrowthAutomationIdentity(request(), {
        ...validConfig,
        MCP_GROWTH_AUD: "shared-audience",
      }),
    ).rejects.toMatchObject({ status: 503 });
    await expect(
      resolveGrowthAutomationIdentity(request(), {
        ...validConfig,
        MCP_GROWTH_PROJECT_IDS: JSON.stringify([
          "53810826-f83d-4e9e-b7fe-f5b26bfa5238",
          "53810826-f83d-4e9e-b7fe-f5b26bfa5238",
        ]),
      }),
    ).rejects.toMatchObject({ status: 503 });
  });

  it("checks raw route and method before reading identity credentials", async () => {
    await expect(
      resolveGrowthAutomationIdentity(
        request("https://seo.katot.dev/mcp"),
        validConfig,
      ),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      resolveGrowthAutomationIdentity(
        request("https://seo.katot.dev/mcp/growth", "GET"),
        validConfig,
      ),
    ).rejects.toMatchObject({ status: 403 });
  });
});
