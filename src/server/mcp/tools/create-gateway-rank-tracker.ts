import { waitUntil } from "cloudflare:workers";
import { z } from "zod";
import { RankTrackingService } from "@/server/features/rank-tracking/services/RankTrackingService";
import { AppError } from "@/server/lib/errors";
import { captureServerEvent } from "@/server/lib/posthog";
import { buildProjectMeta } from "@/server/mcp/context";
import { mcpResponse } from "@/server/mcp/formatters";
import {
  looseObjectOutputSchema,
  optionalMetaOutputSchema,
} from "@/server/mcp/output-schemas";
import { withMcpProjectAuth } from "@/server/mcp/project-auth";
import {
  languageCodeSchema,
  locationCodeSchema,
  projectIdSchema,
} from "@/server/mcp/schemas";
import {
  estimateScheduledRankCheckCredits,
  MAX_TRACKED_KEYWORD_LENGTH,
} from "@/shared/rank-tracking";
import { AUTUMN_SEO_DATA_CREDITS_PER_USD } from "@/shared/billing";
import { domainField } from "@/types/schemas/domain";

// Hard ceiling the gateway can never raise: the monthly spend the owner
// approved for scheduled rank tracking (weekly, mobile).
const MAX_MONTHLY_COST_USD = 0.26;

const inputSchema = {
  projectId: projectIdSchema,
  domain: domainField
    .optional()
    .describe("Site to track. Defaults to the project's domain."),
  keywords: z
    .array(z.string().trim().min(1).max(MAX_TRACKED_KEYWORD_LENGTH))
    .min(1)
    .max(50)
    .describe("Keywords to track."),
  scheduleInterval: z
    .enum(["weekly", "monthly"])
    .optional()
    .describe("How often to check. Defaults to weekly."),
  devices: z
    .enum(["mobile", "desktop", "both"])
    .optional()
    .describe("Devices to track. Defaults to mobile."),
  serpDepth: z
    .number()
    .int()
    .min(10)
    .max(100)
    .multipleOf(10)
    .optional()
    .describe("Google results to inspect per check. Defaults to 10."),
  locationCode: locationCodeSchema.optional(),
  languageCode: languageCodeSchema.optional(),
  maxMonthlyCostUsd: z
    .number()
    .positive()
    .max(MAX_MONTHLY_COST_USD)
    .optional()
    .describe(
      `Most the tracker may cost per month in USD, including retries. Defaults to and cannot exceed ${MAX_MONTHLY_COST_USD}. The request is rejected, and nothing is created, when the projected cost is higher.`,
    ),
} as const;

type Args = z.infer<z.ZodObject<typeof inputSchema>>;

export const createGatewayRankTrackerTool = {
  name: "create_gateway_rank_tracker",
  config: {
    title: "Create scheduled rank tracker",
    description:
      "Create a scheduled (weekly or monthly) rank tracker with its keywords in one step. Defaults to weekly, mobile, top 10. The projected monthly cost (worst case, including retries) is checked first and the request is rejected without creating anything when it exceeds maxMonthlyCostUsd (hard limit $0.26). Creating the tracker starts no check itself; the first scheduled check spends credits. Available to the LiteLLM gateway only.",
    inputSchema,
    outputSchema: z
      .object({
        trackerId: z.string(),
        config: looseObjectOutputSchema,
        keywordsAdded: z.number(),
        estimatedCheckCostCredits: z.number(),
        estimatedMonthlyCostUsd: z.number(),
        estimatedMonthlyCostCredits: z.number(),
        ...optionalMetaOutputSchema,
      })
      .passthrough(),
    annotations: {
      readOnlyHint: false,
      openWorldHint: false,
      destructiveHint: false,
    },
  },
  handler: withMcpProjectAuth(async (args: Args, context) => {
    if (context.auth.principal.kind !== "machine") {
      throw new AppError("FORBIDDEN");
    }
    const domain = args.domain ?? context.project.domain;
    if (!domain) {
      throw new AppError(
        "VALIDATION_ERROR",
        "Provide a domain or set the project's domain first",
      );
    }
    const scheduleInterval = args.scheduleInterval ?? "weekly";
    const devices = args.devices ?? "mobile";
    const serpDepth = args.serpDepth ?? 10;
    const maxMonthlyCostUsd = args.maxMonthlyCostUsd ?? MAX_MONTHLY_COST_USD;

    // Price exactly what will be stored (lowercased, de-duplicated) before
    // writing anything, so a rejected request leaves no tracker behind.
    const keywords = [
      ...new Set(args.keywords.map((keyword) => keyword.toLowerCase())),
    ];
    const estimate = estimateScheduledRankCheckCredits(
      keywords,
      devices,
      serpDepth,
      scheduleInterval,
    );
    const maxMonthlyCredits = Math.round(
      maxMonthlyCostUsd * AUTUMN_SEO_DATA_CREDITS_PER_USD,
    );
    if (
      estimate.monthlyCostUsd > maxMonthlyCostUsd ||
      estimate.monthlyCostCredits > maxMonthlyCredits
    ) {
      throw new AppError(
        "VALIDATION_ERROR",
        `Projected cost is up to $${estimate.monthlyCostUsd.toFixed(4)} per month (${estimate.monthlyCostCredits} credits), above the $${maxMonthlyCostUsd} limit. Nothing was created. Use fewer keywords, a shallower depth, one device, or a monthly schedule.`,
      );
    }

    const config = await RankTrackingService.createConfig({
      projectId: args.projectId,
      projectMarket: context.project,
      domain,
      locationCode: args.locationCode,
      languageCode: args.languageCode,
      devices,
      serpDepth,
      scheduleInterval,
    });
    const added = await RankTrackingService.addKeywords(
      config.id,
      args.projectId,
      keywords,
      {
        kind: "credit_ceiling",
        maxEstimatedScheduledCheckCredits: estimate.costCredits,
      },
    );
    waitUntil(
      captureServerEvent({
        distinctId: context.auth.userId,
        event: "rank_tracking:config_create",
        organizationId: context.auth.organizationId,
        properties: {
          project_id: args.projectId,
          devices: config.devices,
          schedule: config.scheduleInterval,
          source: "mcp",
        },
      }),
    );

    return mcpResponse({
      text: `Created ${config.scheduleInterval} rank tracker ${config.id} for ${config.domain} (${config.devices}, top ${config.serpDepth}) with ${added.added} keyword${added.added === 1 ? "" : "s"}. Worst case ${estimate.costCredits} credits per check, about $${estimate.monthlyCostUsd.toFixed(4)} (${estimate.monthlyCostCredits} credits) per month.${config.nextCheckAt ? ` First scheduled check: ${config.nextCheckAt}.` : ""} No check was started now.`,
      meta: buildProjectMeta(
        context,
        args.projectId,
        `/p/${args.projectId}/rank-tracking/${config.id}`,
      ),
      structuredContent: {
        trackerId: config.id,
        config,
        keywordsAdded: added.added,
        estimatedCheckCostCredits: estimate.costCredits,
        estimatedMonthlyCostUsd: estimate.monthlyCostUsd,
        estimatedMonthlyCostCredits: estimate.monthlyCostCredits,
      },
    });
  }),
};
