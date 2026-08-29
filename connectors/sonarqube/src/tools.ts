import { z } from "zod";
import { createJsonGetter, envAuthHeaders } from "../../../shared/env-json-api.ts";
import { matchesResult } from "../../../shared/mcp-search-tool.ts";
import { mcpJsonResult as jsonResult } from "../../../shared/mcp-tool-kit.ts";
import type { ZodToolRegistrar } from "../../../shared/run-read-only-mcp-connector.ts";
import { filterSonarIssues } from "./search-filter.ts";

const DEFAULT_API = "https://sonarcloud.io";
const ISSUE_TYPES = ["BUG", "VULNERABILITY", "CODE_SMELL"] as const;
const OPEN_STATUSES = ["OPEN", "CONFIRMED", "REOPENED"] as const;

function stripTrailingSlashes(s: string): string {
  let end = s.length;
  while (end > 0 && s.codePointAt(end - 1) === 47) end -= 1;
  return s.slice(0, end);
}

function apiBase(): string {
  const raw = process.env["SONARQUBE_URL"]?.trim();
  if (raw === undefined || raw === "") {
    return DEFAULT_API;
  }
  return stripTrailingSlashes(raw);
}

const sonarGet = createJsonGetter({
  base: apiBase,
  label: "SonarQube",
  headers: envAuthHeaders({ env: "SONARQUBE_TOKEN" }),
});

/** Tool names exposed by this connector — for contract/introspection tests. */
export const SONARQUBE_TOOL_NAMES = [
  "sonarqube_list",
  "sonarqube_get",
  "sonarqube_search",
] as const;

export function registerSonarqubeTools(reg: ZodToolRegistrar): void {
  reg(
    "sonarqube_list",
    "List SonarQube projects, or issues for a project. When projectKey is omitted, returns the project list (SonarCloud requires `SONARQUBE_ORGANIZATION` env; self-hosted ignores it). When projectKey is provided, returns open issues (status OPEN/CONFIRMED/REOPENED) for that project.",
    z.object({
      projectKey: z.string().min(1).optional(),
      types: z.array(z.enum(ISSUE_TYPES)).min(1).optional(),
      severities: z
        .array(z.enum(["BLOCKER", "CRITICAL", "MAJOR", "MINOR", "INFO"]))
        .min(1)
        .optional(),
      limit: z.number().int().min(1).max(500).optional(),
    }),
    async (p) => {
      if (p.projectKey === undefined) {
        const org = process.env["SONARQUBE_ORGANIZATION"]?.trim();
        const search = new URLSearchParams({ qualifiers: "TRK", ps: "100" });
        if (org !== undefined && org !== "") {
          search.set("organization", org);
        }
        return jsonResult(await sonarGet(`/api/components/search?${search.toString()}`));
      }
      const types = p.types ?? ISSUE_TYPES;
      const search = new URLSearchParams({
        componentKeys: p.projectKey,
        types: types.join(","),
        statuses: OPEN_STATUSES.join(","),
        ps: String(p.limit ?? 100),
      });
      if (p.severities !== undefined && p.severities.length > 0) {
        search.set("severities", p.severities.join(","));
      }
      return jsonResult(await sonarGet(`/api/issues/search?${search.toString()}`));
    },
  );

  reg(
    "sonarqube_get",
    "Fetch one SonarQube issue by key. Returns the matching issue envelope from `/api/issues/search?issues=<key>`; throws when no match is found.",
    z.object({
      issueKey: z.string().min(1),
    }),
    async (p) => {
      const search = new URLSearchParams({ issues: p.issueKey, ps: "1" });
      const root = await sonarGet(`/api/issues/search?${search.toString()}`);
      const issues = (root as { issues?: unknown[] } | null)?.issues;
      if (!Array.isArray(issues) || issues.length === 0) {
        throw new Error(`SonarQube: issue ${p.issueKey} not found`);
      }
      return jsonResult(issues[0]);
    },
  );

  reg(
    "sonarqube_search",
    "Substring search across a project's open issues. Matches the query against `message`, `rule`, `component`, and `tags` (case-insensitive). Returns a `{ matches: [...] }` envelope.",
    z.object({
      projectKey: z.string().min(1),
      query: z.string().min(1),
      limit: z.number().int().min(1).max(200).optional(),
    }),
    async (p) => {
      const search = new URLSearchParams({
        componentKeys: p.projectKey,
        types: ISSUE_TYPES.join(","),
        statuses: OPEN_STATUSES.join(","),
        ps: "500",
      });
      const root = await sonarGet(`/api/issues/search?${search.toString()}`);
      const issues = (root as { issues?: unknown[] } | null)?.issues;
      return matchesResult(issues, filterSonarIssues, p);
    },
  );
}
