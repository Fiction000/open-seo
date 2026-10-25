import {
  createRemoteJWKSet,
  errors as joseErrors,
  jwtVerify,
  type JWTPayload,
} from "jose";
import { AuthRepository } from "@/server/auth/repositories/AuthRepository";
import { SHARED_WORKSPACE_ORGANIZATION_ID } from "@/server/auth/delegated-organization";
import { validateTeamDomain } from "@/shared/selfhost-checks";
import { AppError } from "@/server/lib/errors";

export const MCP_GATEWAY_HOST = "seo.katot.dev";

type GatewayIdentity = {
  userId: "service:litellm-openseo";
  userEmail: "litellm-gateway@openseo.invalid";
  organizationId: string;
  role: "member";
  orgScope: "pinned";
  scopes: string[];
  clientId: string;
  principal: {
    kind: "machine";
    service: "litellm-openseo";
    commonName: string;
  };
};

type GatewayEnv = {
  AUTH_MODE?: string;
  TEAM_DOMAIN?: string;
  MCP_GATEWAY_ENABLED?: string;
  MCP_GATEWAY_AUD?: string;
  MCP_GATEWAY_CLIENT_ID?: string;
  MCP_GATEWAY_ORGANIZATION_ID?: string;
};

type GatewayAuthFailure = {
  status: 401 | 403 | 503;
  code: "unauthorized" | "forbidden" | "gateway_unavailable";
};

class GatewayAuthError extends Error {
  constructor(readonly failure: GatewayAuthFailure) {
    super(failure.code);
    this.name = "GatewayAuthError";
  }
}

const jwksByTeamDomain = new Map<
  string,
  ReturnType<typeof createRemoteJWKSet>
>();

function reject(
  status: GatewayAuthFailure["status"],
  code: GatewayAuthFailure["code"],
): never {
  throw new GatewayAuthError({ status, code });
}

function readGatewayEnv(input: unknown): GatewayEnv {
  if (typeof input !== "object" || input === null) return {};
  const readString = (key: keyof GatewayEnv) => {
    const value: unknown = Reflect.get(input, key);
    return typeof value === "string" ? value : undefined;
  };
  return {
    AUTH_MODE: readString("AUTH_MODE"),
    TEAM_DOMAIN: readString("TEAM_DOMAIN"),
    MCP_GATEWAY_ENABLED: readString("MCP_GATEWAY_ENABLED"),
    MCP_GATEWAY_AUD: readString("MCP_GATEWAY_AUD"),
    MCP_GATEWAY_CLIENT_ID: readString("MCP_GATEWAY_CLIENT_ID"),
    MCP_GATEWAY_ORGANIZATION_ID: readString("MCP_GATEWAY_ORGANIZATION_ID"),
  };
}

function requiredConfig(configuration: GatewayEnv) {
  if (configuration.MCP_GATEWAY_ENABLED !== "true") {
    reject(403, "forbidden");
  }
  const teamDomain = configuration.TEAM_DOMAIN?.trim();
  const audience = configuration.MCP_GATEWAY_AUD?.trim();
  const clientId = configuration.MCP_GATEWAY_CLIENT_ID?.trim();
  const organizationId = configuration.MCP_GATEWAY_ORGANIZATION_ID?.trim();
  if (!teamDomain || !audience || !clientId || !organizationId) {
    reject(503, "gateway_unavailable");
  }
  const validatedDomain = validateTeamDomain(teamDomain);
  if (!validatedDomain.ok) reject(503, "gateway_unavailable");
  return {
    teamDomain: validatedDomain.origin,
    audience,
    clientId,
    organizationId,
  };
}

function getJwks(teamDomain: string) {
  let jwks = jwksByTeamDomain.get(teamDomain);
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(`${teamDomain}/cdn-cgi/access/certs`));
    jwksByTeamDomain.set(teamDomain, jwks);
  }
  return jwks;
}

function isInfrastructureFailure(error: unknown) {
  if (!(error instanceof joseErrors.JOSEError)) return true;
  return (
    error instanceof joseErrors.JWKSTimeout ||
    error instanceof joseErrors.JWKSInvalid
  );
}

function requestIsGatewayTarget(request: Request) {
  const url = new URL(request.url);
  return (
    url.origin === `https://${MCP_GATEWAY_HOST}` && url.pathname === "/mcp"
  );
}

export async function resolveMcpGatewayIdentity(
  request: Request,
  configuration: unknown,
): Promise<GatewayIdentity> {
  const gatewayEnv = readGatewayEnv(configuration);
  if (
    !requestIsGatewayTarget(request) ||
    gatewayEnv.AUTH_MODE !== "cloudflare_access"
  ) {
    reject(403, "forbidden");
  }
  const { teamDomain, audience, clientId, organizationId } =
    requiredConfig(gatewayEnv);
  const token = request.headers.get("cf-access-jwt-assertion");
  if (!token) reject(401, "unauthorized");

  let payload: JWTPayload;
  try {
    ({ payload } = await jwtVerify(token, getJwks(teamDomain), {
      issuer: teamDomain,
      algorithms: ["RS256"],
      requiredClaims: ["exp", "iat", "type", "common_name"],
      clockTolerance: 5,
    }));
  } catch (error) {
    if (isInfrastructureFailure(error)) reject(503, "gateway_unavailable");
    reject(401, "unauthorized");
  }

  const now = Math.floor(Date.now() / 1000);
  if (
    typeof payload.iat !== "number" ||
    payload.iat > now + 5 ||
    typeof payload.exp !== "number" ||
    payload.exp <= now
  ) {
    reject(401, "unauthorized");
  }

  const tokenAudiences = Array.isArray(payload.aud)
    ? payload.aud
    : typeof payload.aud === "string"
      ? [payload.aud]
      : [];
  if (!tokenAudiences.includes(audience)) reject(403, "forbidden");
  if (payload.type !== "app" || payload.common_name !== clientId) {
    reject(403, "forbidden");
  }

  if (organizationId !== SHARED_WORKSPACE_ORGANIZATION_ID) {
    reject(403, "forbidden");
  }
  const sharedOrganizationExists =
    await AuthRepository.organizationExists(organizationId);
  if (!sharedOrganizationExists) reject(403, "forbidden");

  return {
    userId: "service:litellm-openseo",
    userEmail: "litellm-gateway@openseo.invalid",
    organizationId,
    role: "member",
    orgScope: "pinned",
    scopes: ["mcp:read"],
    clientId,
    principal: {
      kind: "machine",
      service: "litellm-openseo",
      commonName: clientId,
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readUntrustedPayload(
  request: Request,
): Record<string, unknown> | null {
  const token = request.headers.get("cf-access-jwt-assertion");
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const payloadText = atob(parts[1].replace(/-/g, "+").replace(/_/g, "/"));
    const payload: unknown = JSON.parse(payloadText);
    return isRecord(payload) ? payload : null;
  } catch {
    return null;
  }
}

// Unverified claims only select the restrictive lane. They never authenticate.
export function isMcpGatewayCandidate(
  request: Request,
  configuration: unknown,
) {
  const payload = readUntrustedPayload(request);
  const audience = readGatewayEnv(configuration).MCP_GATEWAY_AUD;
  const audiences = Array.isArray(payload?.aud) ? payload.aud : [payload?.aud];
  // Human Access application JWTs also have type=app. Only service claims,
  // the dedicated audience, or service headers select this deny-only guard.
  return (
    request.headers.has("cf-access-client-id") ||
    request.headers.has("cf-access-client-secret") ||
    (payload !== null && ("common_name" in payload || payload.sub === "")) ||
    Boolean(audience && audiences.includes(audience))
  );
}

export function isMcpGatewayRequestTarget(request: Request) {
  return requestIsGatewayTarget(request);
}

export function gatewayHttpError(error: unknown) {
  if (error instanceof AppError) {
    if (error.code === "UNAUTHENTICATED") {
      return Response.json({ error: "unauthorized" }, { status: 401 });
    }
    if (error.code === "FORBIDDEN") {
      return Response.json({ error: "forbidden" }, { status: 403 });
    }
    if (error.code === "AUTH_CONFIG_MISSING") {
      return Response.json({ error: "gateway_unavailable" }, { status: 503 });
    }
  }
  if (error instanceof GatewayAuthError) {
    return Response.json(
      { error: error.failure.code },
      { status: error.failure.status },
    );
  }
  return Response.json({ error: "internal_error" }, { status: 500 });
}
