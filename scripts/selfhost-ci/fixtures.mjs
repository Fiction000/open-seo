// Synthetic API-shaped fixtures. These are not observations of production.
export const SOURCE_IDS = [
  "11111111-1111-4111-8111-111111111111",
  "22222222-2222-4222-8222-222222222222",
];
export const UPLOAD_IDS = [
  "33333333-3333-4333-8333-333333333333",
  "44444444-4444-4444-8444-444444444444",
];
export function fixtureSnapshot() {
  return Object.fromEntries(
    ["open-seo-selfhost-audit", "open-seo-selfhost"].map((worker, index) => {
      const id = SOURCE_IDS[index];
      const bindings = [
        { name: "DB", type: "d1", id: "fixture-db" },
        { name: "DATAFORSEO_API_KEY", type: "secret_text" },
        { name: "KV", type: "kv_namespace", namespace_id: "fixture-kv" },
        { name: "R2", type: "r2_bucket", bucket_name: "fixture-bucket" },
        {
          name: "SITE_AUDIT_WORKFLOW",
          type: "workflow",
          workflow_name: "fixture-audit",
        },
      ];
      if (index === 0)
        bindings.push(
          { name: "BROWSER", type: "browser" },
          {
            name: "AUDIT_SCRATCHPAD",
            type: "durable_object_namespace",
            namespace_id: "fixture-do",
          },
        );
      else
        bindings.push(
          { name: "ASSETS", type: "assets" },
          { name: "AUTH_MODE", type: "plain_text", text: "cloudflare_access" },
          {
            name: "TEAM_DOMAIN",
            type: "plain_text",
            text: "synthetic.invalid",
          },
          { name: "POLICY_AUD", type: "plain_text", text: "synthetic-aud" },
          { name: "BETTER_AUTH_SECRET", type: "secret_text" },
          { name: "MCP_GATEWAY_ENABLED", type: "plain_text", text: "true" },
          {
            name: "MCP_GATEWAY_AUD",
            type: "plain_text",
            text: "DO-NOT-LOG-fixture-value",
          },
          {
            name: "AUDIT_ENGINE",
            type: "service",
            service: "open-seo-selfhost-audit",
          },
          {
            name: "SAM_CHAT",
            type: "durable_object_namespace",
            namespace_id: "fixture-sam",
          },
          { name: "MCP_RATE_LIMIT", type: "ratelimit" },
        );
      return [
        worker,
        {
          deployments: [
            {
              id: "synthetic-deployment",
              versions: [{ version_id: id, percentage: 100 }],
            },
          ],
          versions: [{ id }],
          active: {
            id,
            resources: {
              script_runtime: {
                compatibility_date: "2025-09-02",
                compatibility_flags: [
                  "nodejs_compat",
                  "global_fetch_strictly_public",
                ],
              },
              bindings,
            },
          },
        },
      ];
    }),
  );
}
