import {
  createRemoteJWKSet,
  errors as joseErrors,
  jwtVerify,
  type JWTPayload,
} from "jose";
import { validateTeamDomain } from "@/shared/selfhost-checks";
import { SHARED_WORKSPACE_ORGANIZATION_ID } from "@/server/auth/delegated-organization";
import type { PersonalAutomationPrincipal } from "@/server/mcp/context";
import { z } from "zod";

export const PERSONAL_MCP_PATH = "/mcp/personal";
export const PERSONAL_MCP_ALLOWED_TOOLS = [
  "whoami",
  "list_projects",
  "get_project_context",
  "update_project_context",
] as const;
export type PersonalMcpTool = (typeof PERSONAL_MCP_ALLOWED_TOOLS)[number];

export type PersonalAutomationEnv = {
  AUTH_MODE?: string;
  TEAM_DOMAIN?: string;
  POLICY_AUD?: string;
  MCP_GATEWAY_AUD?: string;
  MCP_GATEWAY_CLIENT_ID?: string;
  MCP_PERSONAL_ENABLED?: string;
  MCP_PERSONAL_AUD?: string;
  MCP_PERSONAL_CLIENT_ID?: string;
  MCP_PERSONAL_ORGANIZATION_ID?: string;
  MCP_PERSONAL_PROJECT_IDS?: string;
};

export type PersonalAutomationIdentity = {
  principal: PersonalAutomationPrincipal;
  userId: "service:openseo-personal-automation";
  userEmail: "openseo-personal-automation@openseo.invalid";
  organizationId: string;
  role: "member";
  orgScope: "pinned";
  scopes: ["mcp:read"];
  clientId: string;
};

const jwksByDomain = new Map<string, ReturnType<typeof createRemoteJWKSet>>();
const configuredProjectIdsSchema = z.tuple([z.string().uuid(), z.string().uuid()]);
const stringValue = (value: unknown) => typeof value === "string" ? value.trim() : "";

function failure(status: 401 | 403 | 503, code: string): never {
  throw Object.assign(new Error(code), { status, code });
}

function personalConfig(env: PersonalAutomationEnv) {
  if (env.MCP_PERSONAL_ENABLED !== "true") failure(403, "forbidden");
  const team = stringValue(env.TEAM_DOMAIN);
  const aud = stringValue(env.MCP_PERSONAL_AUD);
  const client = stringValue(env.MCP_PERSONAL_CLIENT_ID);
  const org = stringValue(env.MCP_PERSONAL_ORGANIZATION_ID);
  let rawProjects: unknown;
  try {
    rawProjects = JSON.parse(env.MCP_PERSONAL_PROJECT_IDS ?? "");
  } catch {
    failure(503, "personal_mcp_unavailable");
  }
  const parsedProjects = configuredProjectIdsSchema.safeParse(rawProjects);
  const projects = parsedProjects.success ? parsedProjects.data : null;
  if (
    !team || !aud || !client || !org ||
    !projects ||
    new Set(projects).size !== 2 ||
    org !== SHARED_WORKSPACE_ORGANIZATION_ID ||
    aud === env.POLICY_AUD || aud === env.MCP_GATEWAY_AUD || client === env.MCP_GATEWAY_CLIENT_ID
  ) failure(503, "personal_mcp_unavailable");
  const validated = validateTeamDomain(team);
  if (!validated.ok) failure(503, "personal_mcp_unavailable");
  return { team: validated.origin, aud, client, org, projects };
}

function jwks(team: string) {
  let value = jwksByDomain.get(team);
  if (!value) {
    value = createRemoteJWKSet(new URL(`${team}/cdn-cgi/access/certs`));
    jwksByDomain.set(team, value);
  }
  return value;
}

function infra(error: unknown) {
  return !(error instanceof joseErrors.JOSEError) || error instanceof joseErrors.JWKSTimeout || error instanceof joseErrors.JWKSInvalid;
}

export async function resolvePersonalAutomationIdentity(
  request: Request,
  rawEnv: unknown,
): Promise<PersonalAutomationIdentity> {
  const url = new URL(request.url);
  if (url.origin !== "https://seo.katot.dev" || url.pathname !== PERSONAL_MCP_PATH || request.method !== "POST") failure(403, "forbidden");
  if (typeof rawEnv !== "object" || rawEnv === null) failure(403, "forbidden");
  const env = rawEnv as PersonalAutomationEnv;
  if (env.AUTH_MODE !== "cloudflare_access") failure(403, "forbidden");
  const cfg = personalConfig(env);
  const token = request.headers.get("cf-access-jwt-assertion");
  if (!token) failure(401, "unauthorized");
  let payload: JWTPayload;
  try {
    ({ payload } = await jwtVerify(token, jwks(cfg.team), {
      issuer: cfg.team,
      audience: cfg.aud,
      algorithms: ["RS256"],
      requiredClaims: ["exp", "iat", "type", "common_name"],
      clockTolerance: 5,
    }));
  } catch (error) {
    failure(infra(error) ? 503 : 401, infra(error) ? "personal_mcp_unavailable" : "unauthorized");
  }
  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.iat !== "number" || payload.iat > now + 5 || typeof payload.exp !== "number" || payload.exp <= now) failure(401, "unauthorized");
  if (payload.type !== "app" || payload.common_name !== cfg.client) failure(403, "forbidden");
  return {
    principal: { kind: "personal-automation", service: "openseo-personal-automation", commonName: cfg.client, projectIds: cfg.projects },
    userId: "service:openseo-personal-automation",
    userEmail: "openseo-personal-automation@openseo.invalid",
    organizationId: cfg.org,
    role: "member",
    orgScope: "pinned",
    scopes: ["mcp:read"],
    clientId: cfg.client,
  };
}

export function personalMcpHttpError(error: unknown) {
  const status = typeof error === "object" && error !== null && "status" in error ? error.status : 500;
  const code = typeof error === "object" && error !== null && "code" in error ? error.code : "internal_error";
  return Response.json({ error: code }, { status: status === 401 || status === 403 || status === 503 ? status : 500 });
}

export function isPersonalAutomationCandidate(request: Request, rawEnv: unknown) {
  if (typeof rawEnv !== "object" || rawEnv === null) return false;
  const env = rawEnv as PersonalAutomationEnv;
  const token = request.headers.get("cf-access-jwt-assertion");
  const part = token?.split(".")[1];
  if (!part) return false;
  try {
    const payload: unknown = JSON.parse(atob(part.replace(/-/g, "+").replace(/_/g, "/")));
    const parsed = z.record(z.string(), z.unknown()).safeParse(payload);
    if (!parsed.success) return false;
    const claims = parsed.data;
    const cfg = personalConfig(env);
    const matchesAudience = typeof claims.aud === "string"
      ? claims.aud === cfg.aud
      : Array.isArray(claims.aud) && claims.aud.includes(cfg.aud);
    return matchesAudience || claims.common_name === cfg.client;
  } catch {
    return false;
  }
}
