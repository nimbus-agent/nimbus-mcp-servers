import { z } from "zod";
import { createJsonGetter, envAuthHeaders } from "../../../shared/env-json-api.ts";
import { searchToolInputSchema } from "../../../shared/mcp-search-tool.ts";
import { mcpJsonResult as jsonResult } from "../../../shared/mcp-tool-kit.ts";
import type { ZodToolRegistrar } from "../../../shared/run-read-only-mcp-connector.ts";
import { filterMetabaseDashboards } from "./search-filter.ts";

function trimTrailingSlash(s: string): string {
  return s.endsWith("/") ? s.slice(0, -1) : s;
}

function apiBase(): string {
  const v = process.env["METABASE_URL"]?.trim();
  if (v === undefined || v === "") {
    throw new Error("METABASE_URL is not set");
  }
  return trimTrailingSlash(v);
}

const mbGet = createJsonGetter({
  base: apiBase,
  label: "Metabase",
  headers: envAuthHeaders({ env: "METABASE_API_KEY", scheme: "", header: "x-api-key" }),
});

function dashboardsFrom(root: unknown): unknown[] {
  if (Array.isArray(root)) {
    return root;
  }
  const data = (root as { data?: unknown } | null)?.data;
  return Array.isArray(data) ? data : [];
}

/** Tool names exposed by this connector — for contract/introspection tests. */
export const METABASE_TOOL_NAMES = ["metabase_get", "metabase_list", "metabase_search"] as const;

export function registerMetabaseTools(reg: ZodToolRegistrar): void {
  reg(
    "metabase_list",
    "List Metabase dashboards (`GET /api/dashboard`). Metabase returns the full list in one response; `limit` (default 200) caps the returned list client-side.",
    z.object({
      limit: z.number().int().min(1).max(500).optional(),
    }),
    async (p) => {
      const root = await mbGet("/api/dashboard");
      const dashboards = dashboardsFrom(root);
      const cap = p.limit ?? 200;
      return jsonResult({ items: dashboards.slice(0, cap) });
    },
  );

  reg(
    "metabase_get",
    "Fetch one Metabase dashboard by numeric id (`/api/dashboard/{id}`). Throws when no dashboard with that id exists.",
    z.object({
      id: z.number().int(),
    }),
    async (p) => {
      return jsonResult(await mbGet(`/api/dashboard/${encodeURIComponent(String(p.id))}`));
    },
  );

  reg(
    "metabase_search",
    "Substring search across Metabase dashboards. Matches the query (case-insensitive) against dashboard name and description. Returns a `{ matches: [...] }` envelope.",
    searchToolInputSchema(200),
    async (p) => {
      const root = await mbGet("/api/dashboard");
      const matches = filterMetabaseDashboards(dashboardsFrom(root), {
        query: p.query,
        limit: p.limit,
      });
      return jsonResult({ matches });
    },
  );
}
