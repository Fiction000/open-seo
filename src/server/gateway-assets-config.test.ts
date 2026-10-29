import { describe, expect, it } from "vitest";
import { makeWorkerAssets } from "../../deploy/alchemy/alchemy.assets";
import { makeMcpGatewayEnv, makeMcpPersonalEnv } from "../../deploy/alchemy/alchemy.env";

describe("gateway static asset routing", () => {
  it("runs only bounded self-host asset paths through the Worker", () => {
    const paths = makeWorkerAssets("selfhost").runWorkerFirst;
    expect(paths).toContain("/assets/*");
    expect(paths).toContain("/favicon.ico");
    expect(paths).not.toContain("/*");
    expect(makeWorkerAssets("hosted-prod")).not.toHaveProperty(
      "runWorkerFirst",
    );
  });

  it("keeps the gateway disabled and unconfigured outside self-host", () => {
    expect(makeMcpGatewayEnv("hosted-prod")).toEqual({
      MCP_GATEWAY_ENABLED: "false",
      MCP_GATEWAY_AUD: "",
      MCP_GATEWAY_CLIENT_ID: "",
      MCP_GATEWAY_ORGANIZATION_ID: "",
    });
  });

  it("keeps personal automation disabled and unconfigured outside self-host", () => {
    expect(makeMcpPersonalEnv("hosted-prod")).toEqual({
      MCP_PERSONAL_ENABLED: "false",
      MCP_PERSONAL_AUD: "",
      MCP_PERSONAL_CLIENT_ID: "",
      MCP_PERSONAL_ORGANIZATION_ID: "",
      MCP_PERSONAL_PROJECT_IDS: "",
    });
  });
});
