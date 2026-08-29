import { z } from "zod";
import { createJsonGetter, envAuthHeaders } from "../../../shared/env-json-api.ts";
import { matchesResult, searchToolInputSchema } from "../../../shared/mcp-search-tool.ts";
import { mcpJsonResult as jsonResult } from "../../../shared/mcp-tool-kit.ts";
import type { ZodToolRegistrar } from "../../../shared/run-read-only-mcp-connector.ts";
import { filterNetlifySites } from "./search-filter.ts";

const BASE = "https://api.netlify.com";

const netlifyGet = createJsonGetter({
  base: BASE,
  label: "Netlify",
  headers: envAuthHeaders({ env: "NETLIFY_TOKEN" }),
});

/** Tool names exposed by this connector — for contract/introspection tests. */
export const NETLIFY_TOOL_NAMES = ["netlify_get", "netlify_list", "netlify_search"] as const;

export function registerNetlifyTools(reg: ZodToolRegistrar): void {
  reg(
    "netlify_list",
    "List Netlify sites (`GET /api/v1/sites`), capped at `per_page` (default 100). Returns a bare JSON array of site objects, each carrying the embedded `published_deploy` status and `build_settings`.",
    z.object({
      per_page: z.number().int().min(1).max(100).optional(),
    }),
    async (p) => {
      const search = new URLSearchParams({ per_page: String(p.per_page ?? 100), page: "1" });
      return jsonResult(await netlifyGet(`/api/v1/sites?${search.toString()}`));
    },
  );

  reg(
    "netlify_get",
    "Fetch one Netlify site by its id (`GET /api/v1/sites/{siteId}`). Returns the site object directly. Throws when no match is found.",
    z.object({
      siteId: z.string().min(1),
    }),
    async (p) => {
      return jsonResult(await netlifyGet(`/api/v1/sites/${encodeURIComponent(p.siteId)}`));
    },
  );

  reg(
    "netlify_search",
    "Substring search across Netlify sites. Matches the query against id, name, url, ssl_url, the linked git repo + branch, and the published-deploy state / branch / commit ref (case-insensitive). Returns a `{ matches: [...] }` envelope.",
    searchToolInputSchema(100),
    async (p) => {
      const search = new URLSearchParams({ per_page: "100", page: "1" });
      const root = await netlifyGet(`/api/v1/sites?${search.toString()}`);
      return matchesResult(root, filterNetlifySites, p);
    },
  );
}
