import { readFileSync } from "node:fs";
import { expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({
  DurableObject: vi.fn(),
}));

import { OnboardingChatAgent } from "./RetainedOnboardingChatAgent";

it("returns a generic 410 without touching stored conversation state", async () => {
  const storage = new Proxy(
    {},
    {
      get() {
        throw new Error("retired storage must remain untouched");
      },
    },
  );
  const agent = new OnboardingChatAgent(
    { storage } as unknown as DurableObjectState,
    {} as Env,
  );

  const response = await agent.fetch(
    new Request("https://app.example/agents/onboarding_chat/session-secret"),
  );

  expect(response.status).toBe(410);
  expect(await response.text()).not.toContain("session-secret");
});

it("keeps routing restricted to the SAM lobby", () => {
  const server = readFileSync(
    new URL("../../../server.ts", import.meta.url),
    "utf8",
  );
  const authorizer = server.match(
    /function authorizeChatAgent\([\s\S]*?\n}\n/,
  )?.[0];
  const router = server.match(
    /async function routeChatAgents\([\s\S]*?\n}\n/,
  )?.[0];

  expect(authorizer).toContain('lobby.className === "SAM_CHAT"');
  expect(authorizer).toContain('new Response("Forbidden", { status: 403 })');
  expect(router).toContain("onBeforeConnect:");
  expect(router).toContain("onBeforeRequest:");
});

it("retains the legacy binding and never schedules its class deletion", () => {
  const config = readFileSync(
    new URL("../../../../wrangler.jsonc", import.meta.url),
    "utf8",
  );

  expect(config).toContain('"name": "ONBOARDING_CHAT"');
  expect(config).toContain('"class_name": "OnboardingChatAgent"');
  expect(config).not.toMatch(
    /"deleted_classes"\s*:\s*\[[^\]]*OnboardingChatAgent/,
  );
});
