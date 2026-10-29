import { describe, expect, it, vi } from "vitest";
import { isPersonalAutomationCandidate, resolvePersonalAutomationIdentity } from "./personal-auth";

vi.mock("cloudflare:workers", () => ({ env: {} }));
vi.mock("@/server/auth/repositories/AuthRepository", () => ({
  AuthRepository: {},
}));

function selectorToken(claims: Record<string, unknown>) {
  return `x.${btoa(JSON.stringify(claims)).replace(/=/g, "")}.x`;
}

const request = (url = "https://seo.katot.dev/mcp/personal", method = "POST") =>
  new Request(url, { method, headers: { "cf-access-jwt-assertion": "not-a-token" } });

const validConfig = {
  AUTH_MODE: "cloudflare_access",
  TEAM_DOMAIN: "https://team.example.cloudflareaccess.com",
  MCP_GATEWAY_AUD: "shared-audience",
  MCP_GATEWAY_CLIENT_ID: "shared-client",
  MCP_PERSONAL_ENABLED: "true",
  MCP_PERSONAL_AUD: "personal-audience",
  MCP_PERSONAL_CLIENT_ID: "cf-access-automation-client-7f3a",
  MCP_PERSONAL_ORGANIZATION_ID: "shared-workspace",
  MCP_PERSONAL_PROJECT_IDS: JSON.stringify([
    "123e4567-e89b-42d3-a456-426614174000",
    "123e4567-e89b-42d3-a456-426614174001",
  ]),
};

describe("personal automation auth boundary", () => {
  it("selects only tokens matching a valid enabled, non-colliding personal config", () => {
    const req = (claims: Record<string, unknown>) => new Request("https://seo.katot.dev/mcp", { headers: { "cf-access-jwt-assertion": selectorToken(claims) } });
    const personal = req({ aud: "personal-audience", common_name: validConfig.MCP_PERSONAL_CLIENT_ID });
    expect(isPersonalAutomationCandidate(personal, validConfig)).toBe(true);
    for (const bad of [
      { ...validConfig, MCP_PERSONAL_ENABLED: "false" },
      { ...validConfig, MCP_PERSONAL_AUD: "shared-audience" },
      { ...validConfig, MCP_PERSONAL_CLIENT_ID: "shared-client" },
      { ...validConfig, POLICY_AUD: "personal-audience" },
      { ...validConfig, MCP_PERSONAL_PROJECT_IDS: "bad" },
      { ...validConfig, MCP_PERSONAL_AUD: 42 },
    ]) expect(isPersonalAutomationCandidate(personal, bad)).toBe(false);
    expect(isPersonalAutomationCandidate(req({ aud: "other", common_name: "human" }), validConfig)).toBe(false);
  });

  it("fails closed when enabled configuration contains non-string bindings", async () => {
    await expect(resolvePersonalAutomationIdentity(request(), { ...validConfig, TEAM_DOMAIN: 42 })).rejects.toMatchObject({ status: 503 });
  });

  it("fails closed when disabled or bindings are missing", async () => {
    await expect(resolvePersonalAutomationIdentity(request(), {})).rejects.toMatchObject({ status: 403 });
    await expect(resolvePersonalAutomationIdentity(request(), {
      ...validConfig,
      MCP_PERSONAL_ENABLED: "true",
      MCP_PERSONAL_AUD: "",
    })).rejects.toMatchObject({ status: 503 });
  });

  it("rejects colliding identity and non-exact project configuration before JWKS access", async () => {
    await expect(resolvePersonalAutomationIdentity(request(), {
      ...validConfig,
      MCP_PERSONAL_AUD: "shared-audience",
    })).rejects.toMatchObject({ status: 503 });
    await expect(resolvePersonalAutomationIdentity(request(), {
      ...validConfig,
      MCP_PERSONAL_PROJECT_IDS: JSON.stringify([
        "53810826-f83d-4e9e-b7fe-f5b26bfa5238",
        "53810826-f83d-4e9e-b7fe-f5b26bfa5238",
      ]),
    })).rejects.toMatchObject({ status: 503 });
  });

  it("checks raw route and method before reading identity credentials", async () => {
    await expect(resolvePersonalAutomationIdentity(request("https://seo.katot.dev/mcp"), validConfig)).rejects.toMatchObject({ status: 403 });
    await expect(resolvePersonalAutomationIdentity(request("https://seo.katot.dev/mcp/personal", "GET"), validConfig)).rejects.toMatchObject({ status: 403 });
  });
});
