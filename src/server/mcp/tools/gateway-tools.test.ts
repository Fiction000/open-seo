import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createGatewayRankTrackerTool } from "./create-gateway-rank-tracker";
import { getDataforseoBalanceTool } from "./get-dataforseo-balance";
import { makeToolContext, textContent } from "./tool-test-support";

const mocks = vi.hoisted(() => ({
  fetchUserData: vi.fn(),
  getProjectForOrganization: vi.fn(),
  createConfig: vi.fn(),
  addKeywords: vi.fn(),
  captureServerEvent: vi.fn(),
  waitUntil: vi.fn(),
}));

vi.mock("cloudflare:workers", () => ({
  env: {},
  waitUntil: mocks.waitUntil,
}));
vi.mock("@/server/lib/dataforseo/appendix", () => ({
  fetchUserData: mocks.fetchUserData,
}));
vi.mock("@/server/features/projects/services/ProjectService", () => ({
  ProjectService: {
    getProjectForOrganization: mocks.getProjectForOrganization,
  },
}));
vi.mock("@/server/features/rank-tracking/services/RankTrackingService", () => ({
  RankTrackingService: {
    createConfig: mocks.createConfig,
    addKeywords: mocks.addKeywords,
  },
}));
vi.mock("@/server/lib/posthog", () => ({
  captureServerEvent: mocks.captureServerEvent,
}));

const projectId = "11111111-1111-4111-8111-111111111111";
const gateway = makeToolContext({
  principal: {
    kind: "machine",
    service: "litellm-openseo",
    commonName: "gateway",
  },
});

function parseCreate(input: Record<string, unknown>) {
  return z
    .object(createGatewayRankTrackerTool.config.inputSchema)
    .parse({ projectId, ...input });
}

describe("get_dataforseo_balance", () => {
  it("reports the balance for the gateway and refuses other callers", async () => {
    mocks.fetchUserData.mockResolvedValue({
      money: { balance: 4.5, total: 10 },
    });

    const result = await getDataforseoBalanceTool.handler({}, gateway);
    expect(result.structuredContent).toEqual({
      balanceUsd: 4.5,
      totalDepositedUsd: 10,
    });
    expect(textContent(result)).toContain("$4.50");

    mocks.fetchUserData.mockClear();
    await expect(
      getDataforseoBalanceTool.handler({}, makeToolContext()),
    ).rejects.toThrow("FORBIDDEN");
    expect(mocks.fetchUserData).not.toHaveBeenCalled();
  });
});

describe("create_gateway_rank_tracker", () => {
  beforeEach(() => {
    mocks.getProjectForOrganization.mockResolvedValue({
      id: projectId,
      domain: "example.com",
      locationCode: 2840,
      languageCode: "en",
    });
    mocks.createConfig.mockResolvedValue({
      id: "tracker-1",
      domain: "example.com",
      devices: "mobile",
      serpDepth: 10,
      scheduleInterval: "weekly",
    });
    mocks.addKeywords.mockResolvedValue({ added: 10, addedIds: [] });
    mocks.captureServerEvent.mockResolvedValue(undefined);
  });

  it("creates a weekly mobile tracker and caps future checks at the estimate", async () => {
    const keywords = Array.from({ length: 10 }, (_, i) => `keyword ${i}`);
    const result = await createGatewayRankTrackerTool.handler(
      parseCreate({ keywords }),
      gateway,
    );

    expect(mocks.createConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        domain: "example.com",
        devices: "mobile",
        serpDepth: 10,
        scheduleInterval: "weekly",
      }),
    );
    const { estimatedCheckCostCredits, estimatedMonthlyCostUsd } = z
      .object({
        estimatedCheckCostCredits: z.number(),
        estimatedMonthlyCostUsd: z.number(),
      })
      .parse(result.structuredContent);
    expect(estimatedMonthlyCostUsd).toBeLessThanOrEqual(0.26);
    expect(mocks.addKeywords).toHaveBeenCalledWith(
      "tracker-1",
      projectId,
      keywords,
      {
        kind: "credit_ceiling",
        maxEstimatedScheduledCheckCredits: estimatedCheckCostCredits,
      },
    );
  });

  it("rejects a tracker above the monthly cap before creating anything", async () => {
    const keywords = Array.from({ length: 50 }, (_, i) => `keyword ${i}`);
    await expect(
      createGatewayRankTrackerTool.handler(
        parseCreate({ keywords, serpDepth: 50 }),
        gateway,
      ),
    ).rejects.toThrow("above the $0.26 limit");
    expect(mocks.createConfig).not.toHaveBeenCalled();
  });

  it("does not let the caller raise the cap and refuses non-gateway callers", async () => {
    expect(
      z
        .object(createGatewayRankTrackerTool.config.inputSchema)
        .safeParse({ projectId, keywords: ["a"], maxMonthlyCostUsd: 1 })
        .success,
    ).toBe(false);

    await expect(
      createGatewayRankTrackerTool.handler(
        parseCreate({ keywords: ["a"] }),
        makeToolContext(),
      ),
    ).rejects.toThrow("FORBIDDEN");
    expect(mocks.createConfig).not.toHaveBeenCalled();
  });
});
