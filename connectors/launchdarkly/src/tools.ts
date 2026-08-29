import { z } from "zod";
import { createJsonGetter, envAuthHeaders } from "../../../shared/env-json-api.ts";
import { matchesResult } from "../../../shared/mcp-search-tool.ts";
import { mcpJsonResult as jsonResult } from "../../../shared/mcp-tool-kit.ts";
import type { ZodToolRegistrar } from "../../../shared/run-read-only-mcp-connector.ts";
import { filterLaunchDarklyFlags } from "./search-filter.ts";

const DEFAULT_BASE = "https://app.launchdarkly.com";

function baseUrl(): string {
  const v = process.env["LAUNCHDARKLY_BASE_URL"]?.trim();
  return v === undefined || v === "" ? DEFAULT_BASE : v;
}

const ldGet = createJsonGetter({
  base: () => `${baseUrl()}/api/v2`,
  label: "LaunchDarkly",
  headers: envAuthHeaders({ env: "LAUNCHDARKLY_TOKEN", scheme: "" }),
});

/** Tool names exposed by this connector — for contract/introspection tests. */
export const LAUNCHDARKLY_TOOL_NAMES = [
  "launchdarkly_list",
  "launchdarkly_get",
  "launchdarkly_search",
] as const;

export function registerLaunchdarklyTools(reg: ZodToolRegistrar): void {
  reg(
    "launchdarkly_list",
    "List LaunchDarkly projects, or feature flags for a project. Without `projectKey`, returns the account's projects (`/projects`). With `projectKey`, returns that project's flags (`/flags/{projectKey}`), capped at `limit` (default 100).",
    z.object({
      projectKey: z.string().min(1).optional(),
      limit: z.number().int().min(1).max(500).optional(),
    }),
    async (p) => {
      if (p.projectKey === undefined) {
        return jsonResult(await ldGet("/projects"));
      }
      const search = new URLSearchParams({ summary: "true", limit: String(p.limit ?? 100) });
      return jsonResult(
        await ldGet(`/flags/${encodeURIComponent(p.projectKey)}?${search.toString()}`),
      );
    },
  );

  reg(
    "launchdarkly_get",
    "Fetch one LaunchDarkly feature flag by project key + flag key. Throws when no match is found.",
    z.object({
      projectKey: z.string().min(1),
      flagKey: z.string().min(1),
    }),
    async (p) => {
      return jsonResult(
        await ldGet(`/flags/${encodeURIComponent(p.projectKey)}/${encodeURIComponent(p.flagKey)}`),
      );
    },
  );

  reg(
    "launchdarkly_search",
    "Substring search across a project's feature flags. Matches the query against flag key, name, description, and tags (case-insensitive). Returns a `{ matches: [...] }` envelope.",
    z.object({
      projectKey: z.string().min(1),
      query: z.string().min(1),
      limit: z.number().int().min(1).max(200).optional(),
    }),
    async (p) => {
      const search = new URLSearchParams({ summary: "true", limit: "500" });
      const root = await ldGet(`/flags/${encodeURIComponent(p.projectKey)}?${search.toString()}`);
      const flags = (root as { items?: unknown[] } | null)?.items;
      return matchesResult(flags, filterLaunchDarklyFlags, p);
    },
  );
}
