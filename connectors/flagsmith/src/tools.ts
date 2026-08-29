import { z } from "zod";
import { createJsonGetter, envAuthHeaders } from "../../../shared/env-json-api.ts";
import { mcpJsonResult as jsonResult } from "../../../shared/mcp-tool-kit.ts";
import type { ZodToolRegistrar } from "../../../shared/run-read-only-mcp-connector.ts";
import { filterFlagsmithFeatures } from "./search-filter.ts";

const DEFAULT_API_BASE = "https://api.flagsmith.com";

function apiBase(): string {
  const v = process.env["FLAGSMITH_API_BASE"]?.trim();
  return v === undefined || v === "" ? DEFAULT_API_BASE : v;
}

const fsGet = createJsonGetter({
  base: () => `${apiBase()}/api/v1`,
  label: "Flagsmith",
  headers: envAuthHeaders({ env: "FLAGSMITH_TOKEN", scheme: "Token" }),
});

function featuresFromPage(root: unknown): unknown[] {
  if (Array.isArray(root)) {
    return root;
  }
  const results = (root as { results?: unknown } | null)?.results;
  return Array.isArray(results) ? results : [];
}

/** Tool names exposed by this connector — for contract/introspection tests. */
export const FLAGSMITH_TOOL_NAMES = [
  "flagsmith_list",
  "flagsmith_get",
  "flagsmith_search",
] as const;

export function registerFlagsmithTools(reg: ZodToolRegistrar): void {
  reg(
    "flagsmith_list",
    "List Flagsmith projects, or feature flags for a project. Without `projectId`, returns the account's projects (`/projects/`). With `projectId`, returns that project's feature flags (`/projects/{projectId}/features/`), capped at `limit` (default 100).",
    z.object({
      projectId: z.number().int().optional(),
      limit: z.number().int().min(1).max(500).optional(),
    }),
    async (p) => {
      if (p.projectId === undefined) {
        return jsonResult(await fsGet("/projects/"));
      }
      const search = new URLSearchParams({ page_size: String(p.limit ?? 100) });
      return jsonResult(
        await fsGet(
          `/projects/${encodeURIComponent(String(p.projectId))}/features/?${search.toString()}`,
        ),
      );
    },
  );

  reg(
    "flagsmith_get",
    "Fetch one Flagsmith feature flag by project id + feature name. Flagsmith has no GET-by-name endpoint, so this searches the project's features and narrows to the exact-name match. Throws when no match is found.",
    z.object({
      projectId: z.number().int(),
      featureName: z.string().min(1),
    }),
    async (p) => {
      const search = new URLSearchParams({ page_size: "100", search: p.featureName });
      const root = await fsGet(
        `/projects/${encodeURIComponent(String(p.projectId))}/features/?${search.toString()}`,
      );
      const match = featuresFromPage(root).find(
        (f) =>
          f !== null && typeof f === "object" && (f as { name?: unknown }).name === p.featureName,
      );
      if (match === undefined) {
        throw new Error(`Flagsmith feature not found: ${p.featureName}`);
      }
      return jsonResult(match);
    },
  );

  reg(
    "flagsmith_search",
    "Substring search across a project's feature flags. Matches the query against flag name, description, and tags (case-insensitive). Returns a `{ matches: [...] }` envelope.",
    z.object({
      projectId: z.number().int(),
      query: z.string().min(1),
      limit: z.number().int().min(1).max(200).optional(),
    }),
    async (p) => {
      const search = new URLSearchParams({ page_size: "500" });
      const root = await fsGet(
        `/projects/${encodeURIComponent(String(p.projectId))}/features/?${search.toString()}`,
      );
      const matches = filterFlagsmithFeatures(featuresFromPage(root), {
        query: p.query,
        limit: p.limit,
      });
      return jsonResult({ matches });
    },
  );
}
