import { describe, expect, it } from "vitest";
import {
  AUDIT_SECRET_NAMES,
  MAIN_SECRET_NAMES,
  inheritedSecretBindings,
  parseSecretPreservation,
} from "../deploy/alchemy/alchemy.selfhost.ts";

describe("self-host secret preservation", () => {
  it("requires explicit opt-in and independently pinned source versions", () => {
    expect(parseSecretPreservation("", "", "")).toEqual({ enabled: false });
    expect(() => parseSecretPreservation("true", "", "")).toThrow(
      "SELFHOST_PRESERVE_SECRETS must be empty or 1",
    );
    expect(() => parseSecretPreservation("1", "", "")).toThrow(
      "SELFHOST_MAIN_SECRET_SOURCE_VERSION_ID is required",
    );
    expect(() =>
      parseSecretPreservation(
        "1",
        "not-a-uuid",
        "362a0b9b-98db-465f-b7ab-e8ed889292f4",
      ),
    ).toThrow("SELFHOST_MAIN_SECRET_SOURCE_VERSION_ID must be a UUID");
    expect(() =>
      parseSecretPreservation(
        "1",
        "adc8a4ca-48c5-4bdb-b54a-92c8f4a3550b",
        "adc8a4ca-48c5-4bdb-b54a-92c8f4a3550b",
      ),
    ).toThrow("Main and audit source version IDs must be different");
    expect(
      parseSecretPreservation(
        "1",
        "adc8a4ca-48c5-4bdb-b54a-92c8f4a3550b",
        "362a0b9b-98db-465f-b7ab-e8ed889292f4",
      ),
    ).toEqual({
      enabled: true,
      mainVersionId: "adc8a4ca-48c5-4bdb-b54a-92c8f4a3550b",
      auditVersionId: "362a0b9b-98db-465f-b7ab-e8ed889292f4",
    });
  });

  it("uses the scripts API's supported latest secret inheritance", () => {
    expect(inheritedSecretBindings(["SECRET_A"])).toEqual([
      { name: "SECRET_A", type: "inherit", versionId: "latest" },
    ]);
  });

  it("keeps main and audit preservation lists explicit and separate", () => {
    expect(MAIN_SECRET_NAMES).toEqual([
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
    ]);
    expect(AUDIT_SECRET_NAMES).toEqual([
      "AUTUMN_SECRET_KEY",
      "DATAFORSEO_API_KEY",
    ]);
  });
});
