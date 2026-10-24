import * as Alchemy from "alchemy";
import * as CfWorkers from "@distilled.cloud/cloudflare/workers";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import { requireAllowedEmails } from "./alchemy.access.ts";

export const MAIN_SECRET_NAMES = [
  "AUTUMN_SECRET_KEY",
  "AUTUMN_WEBHOOK_SECRET",
  "BETTER_AUTH_SECRET",
  "DATAFORSEO_API_KEY",
  "DUB_API_KEY",
  "GDPR_ERASURE_SECRET",
  "GOOGLE_CLIENT_SECRET",
  "LOOPS_API_KEY",
  "OPENROUTER_API_KEY",
  "TURNSTILE_SECRET_KEY",
] as const;

export const AUDIT_SECRET_NAMES = [
  "AUTUMN_SECRET_KEY",
  "DATAFORSEO_API_KEY",
] as const;

type SecretPreservation =
  | { enabled: false }
  | { enabled: true; mainVersionId: string; auditVersionId: string };

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const parseSecretPreservation = (
  enabled: string,
  mainVersionId: string,
  auditVersionId: string,
): SecretPreservation => {
  if (enabled === "") return { enabled: false };
  if (enabled !== "1") {
    throw new Error("SELFHOST_PRESERVE_SECRETS must be empty or 1");
  }
  if (!mainVersionId) {
    throw new Error("SELFHOST_MAIN_SECRET_SOURCE_VERSION_ID is required");
  }
  if (!uuidPattern.test(mainVersionId)) {
    throw new Error("SELFHOST_MAIN_SECRET_SOURCE_VERSION_ID must be a UUID");
  }
  if (!auditVersionId) {
    throw new Error("SELFHOST_AUDIT_SECRET_SOURCE_VERSION_ID is required");
  }
  if (!uuidPattern.test(auditVersionId)) {
    throw new Error("SELFHOST_AUDIT_SECRET_SOURCE_VERSION_ID must be a UUID");
  }
  if (mainVersionId.toLowerCase() === auditVersionId.toLowerCase()) {
    throw new Error("Main and audit source version IDs must be different");
  }
  return { enabled: true, mainVersionId, auditVersionId };
};

// PUT /workers/scripts only accepts the literal "latest", not a version UUID.
// Assert each worker's latest version separately before planning any mutation.
export const inheritedSecretBindings = (names: readonly string[]) =>
  names.map((name) => ({
    name,
    type: "inherit" as const,
    versionId: "latest",
  }));

export const verifyLatestSecretSources = (preservation: SecretPreservation) =>
  Effect.gen(function* () {
    if (!preservation.enabled) return;
    const { accountId } = yield* yield* Cloudflare.CloudflareEnvironment;
    for (const [scriptName, expected] of [
      ["open-seo-selfhost", preservation.mainVersionId],
      ["open-seo-selfhost-audit", preservation.auditVersionId],
    ]) {
      const versions = yield* CfWorkers.listScriptVersions({
        accountId,
        scriptName,
        perPage: 1,
      }).pipe(Effect.orDie);
      if (versions.result.items?.[0]?.id !== expected) {
        return yield* Effect.die(
          new Error(
            `Latest version changed for ${scriptName}; recapture and review secret sources before deploying`,
          ),
        );
      }
    }
  });

export const readSelfHostSecretPreservation = Effect.gen(function* () {
  const enabled = yield* Config.string("SELFHOST_PRESERVE_SECRETS").pipe(
    Config.withDefault(""),
  );
  const mainVersionId = yield* Config.string(
    "SELFHOST_MAIN_SECRET_SOURCE_VERSION_ID",
  ).pipe(Config.withDefault(""));
  const auditVersionId = yield* Config.string(
    "SELFHOST_AUDIT_SECRET_SOURCE_VERSION_ID",
  ).pipe(Config.withDefault(""));
  return yield* Effect.sync(() =>
    parseSecretPreservation(enabled, mainVersionId, auditVersionId),
  );
});

/**
 * Keep the exact existing selfhost Access resource IDs in Alchemy state even
 * when TEAM_DOMAIN and POLICY_AUD are supplied. Omitting these declarations
 * makes Alchemy plan their deletion. ACCESS_ALLOWED_EMAILS must match the
 * existing allow-policy's owners exactly.
 */
export const manageExistingSelfHostAccess = (stage: string) =>
  Effect.gen(function* () {
    const emails = yield* requireAllowedEmails(
      "Set ACCESS_ALLOWED_EMAILS to the exact existing self-host Access owner list before planning or deploying.",
    );
    const policy = yield* Cloudflare.Access.Policy("SelfHostAllowUsers", {
      name: `open-seo ${stage} self-host users`,
      decision: "allow",
      include: emails.map((email) => ({ email: { email } })),
    }).pipe(Alchemy.RemovalPolicy.retain(true));
    const application = yield* Cloudflare.Access.Application("SelfHostAccess", {
      type: "self_hosted",
      name: `open-seo ${stage}`,
      domain: "seo.katot.dev",
      destinations: [
        { type: "public", uri: "open-seo-selfhost.draconiatk.workers.dev" },
        { type: "public", uri: "seo.katot.dev" },
      ],
      sessionDuration: "168h",
      allowedIdps: [],
      autoRedirectToIdentity: false,
      appLauncherVisible: true,
      tags: [],
      policies: [policy.policyId],
    }).pipe(Alchemy.RemovalPolicy.retain(true));
    const teamDomain = yield* Config.string("TEAM_DOMAIN");
    return { teamDomain, policyAud: application.aud };
  });
