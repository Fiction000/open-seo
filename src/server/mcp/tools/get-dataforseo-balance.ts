import { z } from "zod";
import { fetchUserData } from "@/server/lib/dataforseo/appendix";
import { AppError } from "@/server/lib/errors";
import { type ToolContext } from "@/server/mcp/context";
import { mcpResponse } from "@/server/mcp/formatters";
import { optionalMetaOutputSchema } from "@/server/mcp/output-schemas";

export const getDataforseoBalanceTool = {
  name: "get_dataforseo_balance",
  config: {
    title: "Get DataForSEO balance",
    description:
      "Read the connected DataForSEO account's remaining balance in USD (and lifetime deposits) when the user asks how much credit is left. Uses no credits — it calls DataForSEO's free account endpoint. Available to the LiteLLM gateway only; returns balanceUsd: null when DataForSEO does not report one.",
    inputSchema: {} as Record<string, never>,
    outputSchema: z.looseObject({
      balanceUsd: z.number().nullable(),
      totalDepositedUsd: z.number().nullable(),
      ...optionalMetaOutputSchema,
    }),
    annotations: {
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: true,
      destructiveHint: false,
    },
  },
  handler: async (_args: Record<string, never>, context: ToolContext) => {
    // The balance belongs to the shared provider account, not to a tenant, so
    // only the gateway's machine principal may read it.
    if (context.auth.principal.kind !== "machine") {
      throw new AppError("FORBIDDEN");
    }
    const userData = await fetchUserData();
    const balanceUsd = userData?.money?.balance ?? null;
    const totalDepositedUsd = userData?.money?.total ?? null;
    return mcpResponse({
      text:
        balanceUsd == null
          ? "DataForSEO did not report a balance."
          : `DataForSEO balance: $${balanceUsd.toFixed(2)}${totalDepositedUsd == null ? "" : ` (lifetime deposits $${totalDepositedUsd.toFixed(2)})`}. No credits were used.`,
      structuredContent: { balanceUsd, totalDepositedUsd },
    });
  },
};
