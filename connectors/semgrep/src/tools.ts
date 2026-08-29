import { z } from "zod";
import { createJsonGetter, envAuthHeaders } from "../../../shared/env-json-api.ts";
import { matchesResult, searchToolInputSchema } from "../../../shared/mcp-search-tool.ts";
import { mcpJsonResult as jsonResult } from "../../../shared/mcp-tool-kit.ts";
import type { ZodToolRegistrar } from "../../../shared/run-read-only-mcp-connector.ts";
import { filterSemgrepFindings } from "./search-filter.ts";

const SEMGREP_API = "https://semgrep.dev/api/v1";
const SEVERITIES = ["critical", "high", "medium", "low", "info"] as const;
const STATUSES = ["open", "ignored", "fixed", "removed"] as const;

function deploymentSlug(): string | undefined {
  const v = process.env["SEMGREP_DEPLOYMENT_SLUG"]?.trim();
  return v === undefined || v === "" ? undefined : v;
}

const semgrepGet = createJsonGetter({
  base: SEMGREP_API,
  label: "Semgrep",
  headers: envAuthHeaders({ env: "SEMGREP_TOKEN" }),
});

function requireSlug(): string {
  const slug = deploymentSlug();
  if (slug === undefined) {
    throw new Error("SEMGREP_DEPLOYMENT_SLUG is not set");
  }
  return slug;
}

/** Tool names exposed by this connector — for contract/introspection tests. */
export const SEMGREP_TOOL_NAMES = ["semgrep_get", "semgrep_list", "semgrep_search"] as const;

export function registerSemgrepTools(reg: ZodToolRegistrar): void {
  reg(
    "semgrep_list",
    "List Semgrep deployments, or open findings for the configured deployment. When called without filters, returns the user's deployments (`/deployments`). Provide a `severity` or `status` filter to query findings under the deployment slug from `SEMGREP_DEPLOYMENT_SLUG` env.",
    z.object({
      severity: z.array(z.enum(SEVERITIES)).min(1).optional(),
      status: z.array(z.enum(STATUSES)).min(1).optional(),
      repository: z.string().min(1).optional(),
      limit: z.number().int().min(1).max(500).optional(),
    }),
    async (p) => {
      if (p.severity === undefined && p.status === undefined && p.repository === undefined) {
        return jsonResult(await semgrepGet("/deployments"));
      }
      const slug = requireSlug();
      const search = new URLSearchParams({
        page_size: String(p.limit ?? 100),
      });
      if (p.severity !== undefined && p.severity.length > 0) {
        search.set("severities", p.severity.join(","));
      }
      if (p.status !== undefined && p.status.length > 0) {
        search.set("statuses", p.status.join(","));
      }
      if (p.repository !== undefined) {
        search.set("repos", p.repository);
      }
      const path = `/deployments/${encodeURIComponent(slug)}/findings?${search.toString()}`;
      return jsonResult(await semgrepGet(path));
    },
  );

  reg(
    "semgrep_get",
    "Fetch one Semgrep finding by id from the configured deployment. Returns the matching finding envelope; throws when no match is found.",
    z.object({
      findingId: z.string().min(1),
    }),
    async (p) => {
      const slug = requireSlug();
      const search = new URLSearchParams({ ids: p.findingId, page_size: "1" });
      const path = `/deployments/${encodeURIComponent(slug)}/findings?${search.toString()}`;
      const root = await semgrepGet(path);
      const findings = (root as { findings?: unknown[] } | null)?.findings;
      if (!Array.isArray(findings) || findings.length === 0) {
        throw new Error(`Semgrep: finding ${p.findingId} not found`);
      }
      return jsonResult(findings[0]);
    },
  );

  reg(
    "semgrep_search",
    "Substring search across the deployment's open findings. Matches the query against `rule_name`, `rule_message`, `location.file_path`, and `repository.name` (case-insensitive). Returns a `{ matches: [...] }` envelope.",
    searchToolInputSchema(200),
    async (p) => {
      const slug = requireSlug();
      const search = new URLSearchParams({
        statuses: "open",
        page_size: "500",
      });
      const path = `/deployments/${encodeURIComponent(slug)}/findings?${search.toString()}`;
      const root = await semgrepGet(path);
      const findings = (root as { findings?: unknown[] } | null)?.findings;
      return matchesResult(findings, filterSemgrepFindings, p);
    },
  );
}
