import * as Config from "effect/Config";
import { Redacted } from "effect";

export const optionalVar = (name: string) =>
  Config.string(name).pipe(
    Config.withDefault(""),
    Config.map((value) => value.trim()),
  );

const existingValueForStage = (stage: string, name: string) =>
  stage === "selfhost" ? Config.string(name) : optionalVar(name);

const optionalSecret = (name: string) =>
  Config.redacted(name).pipe(Config.withDefault(Redacted.make("")));

// Cloudflare's secret API is write-only. An absent input must stop a selfhost
// deployment rather than bind an empty value over a live secret.
const secretForStage = (stage: string, name: string) =>
  stage === "selfhost" ? Config.redacted(name) : optionalSecret(name);

// Secrets/vars resolve from Config (`Config.redacted` → Cloudflare
// `secret_text`, `Config.string` → plaintext var). Previews and self-host pass
// an `--env-file`, which the alchemy CLI loads into Config, NOT process.env;
// the production workflow exports them as job/step env instead.
export const makeDataEnv = (stage: string, preserveSecrets: boolean) => ({
  // AUTH_MODE, DATABASE_PROVIDER, BETTER_AUTH_URL, TEAM_DOMAIN, and
  // POLICY_AUD are stage-dependent and set in the stack body below.
  ...(!preserveSecrets
    ? { DATAFORSEO_API_KEY: Config.redacted("DATAFORSEO_API_KEY") }
    : {}),
  BYPASS_EMAIL_VERIFICATION: optionalVar("BYPASS_EMAIL_VERIFICATION"),
  ...(!preserveSecrets
    ? { BETTER_AUTH_SECRET: secretForStage(stage, "BETTER_AUTH_SECRET") }
    : {}),
  CRAWLER_ACCESS_SECRET: optionalSecret("CRAWLER_ACCESS_SECRET"),
  WEB_BOT_AUTH_JWK: optionalSecret("WEB_BOT_AUTH_JWK"),
  GOOGLE_CLIENT_ID: existingValueForStage(stage, "GOOGLE_CLIENT_ID"),
  ...(!preserveSecrets
    ? { GOOGLE_CLIENT_SECRET: secretForStage(stage, "GOOGLE_CLIENT_SECRET") }
    : {}),
  GOOGLE_MAPS_API_KEY: optionalSecret("GOOGLE_MAPS_API_KEY"),
  ...(!preserveSecrets
    ? { OPENROUTER_API_KEY: secretForStage(stage, "OPENROUTER_API_KEY") }
    : {}),
  OPENROUTER_MODEL: optionalVar("OPENROUTER_MODEL"),
  CONTEXT_API_KEY: optionalSecret("CONTEXT_API_KEY"),
  ...(!preserveSecrets
    ? {
        AUTUMN_SECRET_KEY: secretForStage(stage, "AUTUMN_SECRET_KEY"),
        AUTUMN_WEBHOOK_SECRET: secretForStage(stage, "AUTUMN_WEBHOOK_SECRET"),
        DUB_API_KEY: secretForStage(stage, "DUB_API_KEY"),
      }
    : {}),
  META_PIXEL_ID: optionalVar("META_PIXEL_ID"),
  META_CONVERSIONS_API_TOKEN: optionalSecret("META_CONVERSIONS_API_TOKEN"),
  ...(!preserveSecrets
    ? {
        GDPR_ERASURE_SECRET: secretForStage(stage, "GDPR_ERASURE_SECRET"),
        LOOPS_API_KEY: secretForStage(stage, "LOOPS_API_KEY"),
      }
    : {}),
  LOOPS_TRANSACTIONAL_VERIFY_EMAIL_ID: optionalVar(
    "LOOPS_TRANSACTIONAL_VERIFY_EMAIL_ID",
  ),
  LOOPS_TRANSACTIONAL_RESET_PASSWORD_ID: optionalVar(
    "LOOPS_TRANSACTIONAL_RESET_PASSWORD_ID",
  ),
  LOOPS_TRANSACTIONAL_INVITATION_ID: optionalVar(
    "LOOPS_TRANSACTIONAL_INVITATION_ID",
  ),
  LOOPS_PRODUCT_UPDATES_LIST_ID: optionalVar("LOOPS_PRODUCT_UPDATES_LIST_ID"),
  POSTHOG_PUBLIC_KEY: optionalVar("POSTHOG_PUBLIC_KEY"),
  POSTHOG_HOST: optionalVar("POSTHOG_HOST"),
  ...(!preserveSecrets
    ? { TURNSTILE_SECRET_KEY: secretForStage(stage, "TURNSTILE_SECRET_KEY") }
    : {}),
  TURNSTILE_SITE_KEY: optionalVar("TURNSTILE_SITE_KEY"),
  // Alchemy reconciles worker vars and secrets on every deploy, so every value
  // must come from the env file / GitHub environment — a dashboard-set one
  // would be wiped. Self-host already has telemetry disabled; make that the
  // safe default even when the deploy file omits the value.
  OPENSEO_TELEMETRY_DISABLED:
    stage === "selfhost"
      ? Config.string("OPENSEO_TELEMETRY_DISABLED").pipe(
          Config.withDefault("1"),
        )
      : optionalVar("OPENSEO_TELEMETRY_DISABLED"),
});
