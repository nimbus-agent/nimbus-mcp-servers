import { z } from "zod";
import { createJsonGetter, envAuthHeaders } from "../../../shared/env-json-api.ts";
import { searchToolInputSchema } from "../../../shared/mcp-search-tool.ts";
import { mcpJsonResult as jsonResult } from "../../../shared/mcp-tool-kit.ts";
import type { ZodToolRegistrar } from "../../../shared/run-read-only-mcp-connector.ts";
import { stripTrailingSlashes } from "../../../shared/strip-trailing-slashes.ts";
import { filterDependencyTrackProjects } from "./search-filter.ts";

function apiBase(): string {
  const v = process.env["DEPENDENCYTRACK_URL"]?.trim();
  if (v === undefined || v === "") {
    throw new Error("DEPENDENCYTRACK_URL is not set");
  }
  return stripTrailingSlashes(v);
}

const dtGet = createJsonGetter({
  base: apiBase,
  label: "Dependency-Track",
  headers: envAuthHeaders({ env: "DEPENDENCYTRACK_API_KEY", scheme: "", header: "X-Api-Key" }),
});

function projectsFrom(root: unknown): unknown[] {
  return Array.isArray(root) ? root : [];
}

/** Tool names exposed by this connector — for contract/introspection tests. */
export const DEPENDENCYTRACK_TOOL_NAMES = [
  "dependencytrack_list",
  "dependencytrack_get",
  "dependencytrack_search",
] as const;

export function registerDependencytrackTools(reg: ZodToolRegistrar): void {
  reg(
    "dependencytrack_list",
    "List Dependency-Track projects (GET /api/v1/project?pageSize=100&pageNumber=1&excludeInactive=false). Dependency-Track returns a JSON array of project objects, each embedding its current vulnerability metrics. The optional pageNumber arg (default 1) selects the page; pageSize is fixed at 100.",
    z.object({
      pageNumber: z.number().int().min(1).optional(),
    }),
    async (p) => {
      const page = p.pageNumber ?? 1;
      const root = await dtGet(
        `/api/v1/project?pageSize=100&pageNumber=${encodeURIComponent(String(page))}&excludeInactive=false`,
      );
      return jsonResult({ items: projectsFrom(root) });
    },
  );

  reg(
    "dependencytrack_get",
    "Fetch one Dependency-Track project by its UUID (GET /api/v1/project/{uuid}). Returns the project object directly (NOT wrapped in an array). Throws when no project with that UUID exists.",
    z.object({
      uuid: z.string().min(1),
    }),
    async (p) => {
      return jsonResult(await dtGet(`/api/v1/project/${encodeURIComponent(p.uuid)}`));
    },
  );

  reg(
    "dependencytrack_search",
    "Substring search across the first page of Dependency-Track projects. Matches the query (case-insensitive) against the project name, version, classifier, and tag names. Returns a matches envelope.",
    searchToolInputSchema(100),
    async (p) => {
      const root = await dtGet("/api/v1/project?pageSize=100&pageNumber=1&excludeInactive=false");
      const matches = filterDependencyTrackProjects(projectsFrom(root), {
        query: p.query,
        limit: p.limit,
      });
      return jsonResult({ matches });
    },
  );
}
