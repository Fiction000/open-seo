import { createGatewayRankTrackerTool } from "@/server/mcp/tools/create-gateway-rank-tracker";
import { getDataforseoBalanceTool } from "@/server/mcp/tools/get-dataforseo-balance";

type Register = {
  (tool: typeof getDataforseoBalanceTool): void;
  (tool: typeof createGatewayRankTrackerTool): void;
};

/** Registers the tools only the LiteLLM gateway's machine principal is offered. */
export function registerGatewayOnlyTools(register: Register) {
  register(getDataforseoBalanceTool);
  register(createGatewayRankTrackerTool);
}
