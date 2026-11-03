# OpenSEO growth lane (`/mcp/growth`): read-only MCP for `head-of-growth`

Status: code only, default OFF. Nothing in this PR enables it.
Date: 2026-11-03. Owner of rollout: Nouska (integration). Approver: Tatsu.

## What this adds

- A third MCP principal, `growth-automation`, on its own route `https://seo.katot.dev/mcp/growth` (POST only, exact host/path, checked before auth).
- Its own Cloudflare Access app and service token. The shared `/mcp` app and its policy, and the `/mcp/personal` app, are not touched.
- A fixed server-side allowlist of 47 tools, enforced twice: at `tools/list` registration and again at `tools/call` before dispatch. The shared 16-name machine allowlist (live LiteLLM allowed_tools: 14) is unchanged and asserted by a test.
- Project scope: only the project UUIDs in `MCP_GROWTH_PROJECT_IDS` (1 to 10). Other project IDs are refused before any service read.
- Audience and client collisions with `POLICY_AUD`, `MCP_GATEWAY_*`, and `MCP_PERSONAL_*` fail closed.

## Tiers (summary; full table in the Agent Vault note)

- T0 free read-only: whoami, list_projects, get_project_context, list_saved_keywords, search_serp_locations, get_dataforseo_balance, 12 Search Console/GA4 tools, list_site_audits, get_audit_status, get_audit_issues, get_audit_pages, list_reports, get_report, list_report_templates, get_rank_tracker, estimate_rank_tracker_cost, estimate_ai_visibility_cost, get_ai_visibility_tracker/run/results/answer/sources/trend, export_ai_visibility_data.
- T1 paid reads that save nothing (estimate-first by convention, see below): research_keywords, get_keyword_metrics, get_domain_overview, get_domain_keyword_suggestions, get_domain_history, get_ranked_keywords, find_serp_competitors, get_serp_results, get_backlinks_overview, get_backlinks_profile, research_ai_visibility_prompts, generate_ai_visibility_prompts.
- T2 NOT exposed: everything that saves, starts a job, schedules, tracks, publishes, or deletes (see "Per-run grants").

Spend control. Only `run_ai_visibility_check` has a server-side cap (`maxCostUsd`), and it is T2. The T1 tools charge per call with no server-side cap, so the caller must read the cost in the tool description, call `get_dataforseo_balance` before and after, and report spend. The lane's MCP `instructions` tell the agent this.

## Rollout (Nouska; every step needs Tatsu's go)

1. Merge this PR (after the merge gate) and deploy the Worker with the new bindings left unset (lane stays disabled). Readback: `curl -s -o /dev/null -w "%{http_code}" -X POST https://seo.katot.dev/mcp/growth` returns 401/403 from Access, and `tools/list` on `/mcp` and `/mcp/personal` is unchanged (14 and 4 tools).
2. Create the Access app (separate from the shared and personal apps):
   - type self_hosted, name `OpenSEO Growth Read-only MCP`
   - destinations `seo.katot.dev/mcp/growth` and `seo.katot.dev/mcp/growth/*`
   - one policy, decision `non_identity`, include only a NEW service token `OpenSEO growth automation <date>` (do not reuse the shared or personal tokens), `app_launcher_visible:false`, `allowed_idps:[]`
   - store the token in 1Password with the existing service-account flow. Never print it.
   - record the app `aud` and the token `client_id`.
3. Set Worker vars for the selfhost stage, then redeploy: `MCP_GROWTH_ENABLED=true`, `MCP_GROWTH_AUD=<new app aud>`, `MCP_GROWTH_CLIENT_ID=<new token client_id>`, `MCP_GROWTH_ORGANIZATION_ID=shared-workspace`, `MCP_GROWTH_PROJECT_IDS=["<uuid>", ...]` (JSON array, 1 to 10 UUIDs, Tatsu picks the projects).
4. Create the LiteLLM MCP server (admin API, `./up` only if a restart is needed):
   - `server_name: openseo_growth`, `url: https://seo.katot.dev/mcp/growth`, `transport: http`
   - `allow_all_keys: false`, `available_on_public_internet: false`
   - `allowed_tools`: exactly the 47 names below
   - Access headers for the new token as extra headers (same mechanism as `openseo_personal`)
5. Create a NEW LiteLLM virtual key for `head-of-growth` only (alias `head-of-growth`), with `object_permission.mcp_servers=["openseo_growth"]` and `mcp_tool_permissions.openseo_growth=<same 47 names>`. Set a `max_budget`/`rpm_limit` only if Tatsu asks (the task said: do not change LiteLLM limits). Do not add this server to the main Hermes key. Put the key in `/Users/kawana/.hermes/profiles/head-of-growth/.env` as `MCP_LITELLM_GROWTH_KEY` through 1Password; never in chat.
6. Add this to `/Users/kawana/.hermes/profiles/head-of-growth/config.yaml` (not edited by this PR):

```yaml
mcp_servers:
  openseo_growth:
    url: http://127.0.0.1:4000/mcp/openseo_growth
    headers:
      Authorization: Bearer ${MCP_LITELLM_GROWTH_KEY}
    enabled: true
    tools:
      include:
        - openseo_growth-whoami
        - openseo_growth-list_projects
        - openseo_growth-get_project_context
        - openseo_growth-list_saved_keywords
        - openseo_growth-search_serp_locations
        - openseo_growth-get_dataforseo_balance
        - openseo_growth-get_search_console_performance
        - openseo_growth-inspect_urls
        - openseo_growth-get_google_analytics_organic_landing_pages
        - openseo_growth-get_google_analytics_page_performance
        - openseo_growth-get_google_analytics_key_events
        - openseo_growth-get_search_opportunities
        - openseo_growth-get_google_analytics_organic_overview
        - openseo_growth-get_google_analytics_traffic_acquisition
        - openseo_growth-get_google_analytics_ecommerce_performance
        - openseo_growth-get_google_analytics_site_search
        - openseo_growth-get_google_analytics_audience_breakdown
        - openseo_growth-get_google_analytics_measurement_health
        - openseo_growth-list_site_audits
        - openseo_growth-get_audit_status
        - openseo_growth-get_audit_issues
        - openseo_growth-get_audit_pages
        - openseo_growth-list_reports
        - openseo_growth-get_report
        - openseo_growth-list_report_templates
        - openseo_growth-get_rank_tracker
        - openseo_growth-estimate_rank_tracker_cost
        - openseo_growth-estimate_ai_visibility_cost
        - openseo_growth-get_ai_visibility_tracker
        - openseo_growth-get_ai_visibility_run
        - openseo_growth-get_ai_visibility_results
        - openseo_growth-get_ai_visibility_answer
        - openseo_growth-get_ai_visibility_sources
        - openseo_growth-get_ai_visibility_trend
        - openseo_growth-export_ai_visibility_data
        - openseo_growth-research_keywords
        - openseo_growth-get_keyword_metrics
        - openseo_growth-get_domain_overview
        - openseo_growth-get_domain_keyword_suggestions
        - openseo_growth-get_domain_history
        - openseo_growth-get_ranked_keywords
        - openseo_growth-find_serp_competitors
        - openseo_growth-get_serp_results
        - openseo_growth-get_backlinks_overview
        - openseo_growth-get_backlinks_profile
        - openseo_growth-research_ai_visibility_prompts
        - openseo_growth-generate_ai_visibility_prompts
```

Note: LiteLLM prefixes tool names with the server name, so `include` uses `openseo_growth-<tool>`. The `mcp_servers` block in the main profile is not changed.

7. Readback checks (read-only):
   - Direct Worker with the new Access token: `initialize` + `tools/list` returns exactly the 47 names; `tools/call update_project_context` returns "Tool not allowed"/unknown tool.
   - LiteLLM with the head-of-growth key: `tools/list` on `/mcp/openseo_growth` returns the same 47 names with the `openseo_growth-` prefix. Send `Accept: application/json, text/event-stream`; with `application/json` only, LiteLLM answers 406 (that is the "MCP error" seen on 2026-11-03, not an outage).
   - The main Hermes key, `tools/list` on `/mcp`: no `openseo_growth-*` tools. The main key calling `/mcp/openseo_growth` is refused.
   - `whoami` returns `creditsRemaining:null`; `list_projects` returns only the configured UUIDs.
   - `get_dataforseo_balance` returns a USD number (free).
8. First paid use is a separate approval per run. See below.

## Per-run grants for the first AI-visibility measurement (T2, not in allowlist)

To measure mention/citation rate on a fixed prompt set, Tatsu approves each run, and Nouska temporarily adds only what is needed to a separate LiteLLM key/grant (not this lane):

1. `save_ai_visibility_tracker`: save the fixed prompt set and brands (writes).
2. `estimate_ai_visibility_cost` (already allowed): show `runNowCostUsd`.
3. `run_ai_visibility_check` with `maxCostUsd` = the approved `runNowCostUsd` (paid, capped).
4. Reads: `get_ai_visibility_run` (poll), `get_ai_visibility_results`, `_answer`, `_sources`, `_trend`, `export_ai_visibility_data` (already allowed).

Never grant without a separate approval: `set_ai_visibility_schedule` (recurring spend), `complete_ai_research_setup`, `explore_prompt`, `run_site_audit`, `create_rank_tracker`/`run_rank_tracker`, `save_report`, any `delete_*`/`remove_*`, `update_project_context`, `save_project_website_setup`, `research_project_website`.

## Rollback

1. Delete the head-of-growth LiteLLM virtual key (or remove `openseo_growth` from its object_permission) and delete the profile `mcp_servers.openseo_growth` block.
2. Delete or disable the LiteLLM server `openseo_growth`.
3. Disable the Access app (or delete the policy) and revoke the growth service token.
4. Set `MCP_GROWTH_ENABLED=false` (or empty the vars) and redeploy, or revert this PR. No schema or migration is involved, so there is nothing to roll back in the database.

## Allowed tool names (47)

whoami, list_projects, get_project_context, list_saved_keywords, search_serp_locations, get_dataforseo_balance, get_search_console_performance, inspect_urls, get_google_analytics_organic_landing_pages, get_google_analytics_page_performance, get_google_analytics_key_events, get_search_opportunities, get_google_analytics_organic_overview, get_google_analytics_traffic_acquisition, get_google_analytics_ecommerce_performance, get_google_analytics_site_search, get_google_analytics_audience_breakdown, get_google_analytics_measurement_health, list_site_audits, get_audit_status, get_audit_issues, get_audit_pages, list_reports, get_report, list_report_templates, get_rank_tracker, estimate_rank_tracker_cost, estimate_ai_visibility_cost, get_ai_visibility_tracker, get_ai_visibility_run, get_ai_visibility_results, get_ai_visibility_answer, get_ai_visibility_sources, get_ai_visibility_trend, export_ai_visibility_data, research_keywords, get_keyword_metrics, get_domain_overview, get_domain_keyword_suggestions, get_domain_history, get_ranked_keywords, find_serp_competitors, get_serp_results, get_backlinks_overview, get_backlinks_profile, research_ai_visibility_prompts, generate_ai_visibility_prompts
