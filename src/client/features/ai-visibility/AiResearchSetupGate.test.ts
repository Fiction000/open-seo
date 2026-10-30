import React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { AiResearchSetupGate } from "./AiResearchSetupGate";
import { aiResearchSetupQueryOptions, aiTrackerQueryOptions } from "./shared";
import { startAiResearchSetup } from "@/serverFunctions/ai-visibility";

let pathname = "/p/p1/ai-visibility";
vi.mock("@tanstack/react-router", () => ({
  Link: () => null,
  useRouterState: () => pathname,
}));
vi.mock("@/serverFunctions/ai-visibility", () => ({
  getAiResearchSetup: vi.fn(),
  getAiVisibilityTracker: vi.fn(),
  getAiVisibilityRun: vi.fn(),
  getAiVisibilityTrend: vi.fn(),
  getAiVisibilityResults: vi.fn(),
  listAiResearchKeywords: vi.fn(),
  startAiResearchSetup: vi.fn(),
}));
vi.mock("@/client/features/projects/projectQueries", () => ({
  projectsQueryOptions: () => ({ queryKey: ["projects"] }),
}));
vi.mock("@/serverFunctions/projectContext", () => ({
  updateProjectContext: vi.fn(),
}));
vi.mock("@/serverFunctions/projectWebsite", () => ({
  saveProjectWebsiteSetup: vi.fn(),
}));

const setup = {
  keywords: [],
  missingOverview: false,
  missingCompetitors: true,
  status: "none" as const,
  review: null,
  failure: null,
};
const tracker = (configured: boolean) => ({
  configured,
  tracker: configured
    ? {
        id: "tracker",
        projectId: "project",
        enabled: false,
        locationCode: 2840,
        languageCode: "en",
        scheduleInterval: "weekly" as const,
        nextCheckAt: null,
        lastSkipReason: null,
        createdAt: "2026-01-01T00:00:00.000Z",
      }
    : null,
  topics: [],
  prompts: [],
  brands: [],
  engines: [],
  capabilities: [],
  recentRuns: [],
  providerConfigured: false,
});

function page(
  projectId: string,
  allowConfiguredTracker: boolean,
  configured = true,
  client = new QueryClient(),
  trackerStatus: "success" | "pending" | "error" = "success",
) {
  client.setQueryData(aiResearchSetupQueryOptions(projectId).queryKey, setup);
  const trackerOptions = aiTrackerQueryOptions(projectId);
  if (trackerStatus === "success") {
    client.setQueryData(trackerOptions.queryKey, tracker(configured));
  } else if (trackerStatus === "error") {
    client.setQueryDefaults(trackerOptions.queryKey, { retryOnMount: false });
    client
      .getQueryCache()
      .build(client, { queryKey: trackerOptions.queryKey })
      .setState({
        status: "error",
        error: new Error("Tracker could not be loaded"),
      });
  }
  return renderToStaticMarkup(
    React.createElement(
      QueryClientProvider,
      { client },
      React.createElement(AiResearchSetupGate, {
        projectId,
        allowConfiguredTracker,
        children: React.createElement("main", null, "Prompt Tracking"),
      }),
    ),
  );
}

describe("AI visibility setup gate", () => {
  it("shows configured manual tracking without starting research", () => {
    pathname = "/p/p1/ai-visibility";
    const html = page("p1", true);
    expect(html).toContain("Prompt Tracking");
    expect(html).not.toContain("Start research");
    expect(startAiResearchSetup).not.toHaveBeenCalled();
  });

  it("keeps Prompt Research behind keyword setup even with a tracker", () => {
    pathname = "/p/p1/ai-visibility/research";
    const html = page("p1", true);
    expect(html).not.toContain("Prompt Tracking");
    expect(html).toContain("Start research");
  });

  it("does not use a previous project's tracker for the next project", () => {
    const client = new QueryClient();
    client.setQueryData(aiTrackerQueryOptions("p1").queryKey, tracker(true));
    pathname = "/p/p2/ai-visibility";
    const html = page("p2", true, false, client);
    expect(html).not.toContain("Prompt Tracking");
    expect(html).toContain("Start research");
    expect(client.getQueryData(aiTrackerQueryOptions("p1").queryKey)).toEqual(
      tracker(true),
    );
  });

  it("does not offer paid research while the tracker is loading", () => {
    pathname = "/p/p1/ai-visibility";
    const html = page("p1", true, false, new QueryClient(), "pending");
    expect(html).not.toContain("Prompt Tracking");
    expect(html).not.toContain("Start research");
  });

  it("shows the tracker error instead of offering paid research", () => {
    pathname = "/p/p1/ai-visibility";
    const html = page("p1", true, false, new QueryClient(), "error");
    expect(html).toContain("Tracker could not be loaded");
    expect(html).not.toContain("Start research");
  });

  it("keeps standalone Prompt Explorer behind keyword setup", () => {
    pathname = "/p/p1/prompt-explorer";
    expect(page("p1", false)).not.toContain("Prompt Tracking");
  });
});
