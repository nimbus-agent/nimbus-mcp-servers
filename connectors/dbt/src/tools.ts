import { z } from "zod";
import { createJsonGetter, envAuthHeaders } from "../../../shared/env-json-api.ts";
import { mcpJsonResult as jsonResult } from "../../../shared/mcp-tool-kit.ts";
import type { ZodToolRegistrar } from "../../../shared/run-read-only-mcp-connector.ts";
import { stripTrailingSlashes } from "../../../shared/strip-trailing-slashes.ts";
import { filterDbtJobs } from "./search-filter.ts";

const DEFAULT_API_BASE = "https://cloud.getdbt.com";

function apiBase(): string {
  const v = process.env["DBT_API_BASE"]?.trim();
  return v === undefined || v === "" ? DEFAULT_API_BASE : stripTrailingSlashes(v);
}

const dbtGet = createJsonGetter({
  base: () => `${apiBase()}/api/v2`,
  label: "dbt Cloud",
  headers: envAuthHeaders({ env: "DBT_TOKEN", scheme: "Token" }),
});

function dataFrom(root: unknown): unknown[] {
  if (Array.isArray(root)) {
    return root;
  }
  const data = (root as { data?: unknown } | null)?.data;
  return Array.isArray(data) ? data : [];
}

/** Tool names exposed by this connector — for contract/introspection tests. */
export const DBT_TOOL_NAMES = ["dbt_get", "dbt_list", "dbt_search"] as const;

export function registerDbtTools(reg: ZodToolRegistrar): void {
  reg(
    "dbt_list",
    "List dbt Cloud accounts, or jobs for an account. Without `accountId`, returns the account's accounts (`/accounts/`). With `accountId`, returns that account's jobs (`/accounts/{accountId}/jobs/`), capped at `limit` (default 100). Returns the raw dbt Cloud envelope (`{ data: [...] }`).",
    z.object({
      accountId: z.number().int().optional(),
      limit: z.number().int().min(1).max(500).optional(),
    }),
    async (p) => {
      if (p.accountId === undefined) {
        return jsonResult(await dbtGet("/accounts/"));
      }
      const search = new URLSearchParams({ limit: String(p.limit ?? 100) });
      return jsonResult(
        await dbtGet(
          `/accounts/${encodeURIComponent(String(p.accountId))}/jobs/?${search.toString()}`,
        ),
      );
    },
  );

  reg(
    "dbt_get",
    "Fetch one dbt Cloud job by `accountId` + `jobId` (`/accounts/{accountId}/jobs/{jobId}/`). Returns the raw dbt Cloud envelope. Throws when no such job exists.",
    z.object({
      accountId: z.number().int(),
      jobId: z.number().int(),
    }),
    async (p) => {
      return jsonResult(
        await dbtGet(
          `/accounts/${encodeURIComponent(String(p.accountId))}/jobs/${encodeURIComponent(String(p.jobId))}/`,
        ),
      );
    },
  );

  reg(
    "dbt_search",
    "Substring search across an account's dbt Cloud jobs. Matches the query against job name, dbt version, and id (case-insensitive). Returns a `{ matches: [...] }` envelope.",
    z.object({
      accountId: z.number().int(),
      query: z.string().min(1),
      limit: z.number().int().min(1).max(200).optional(),
    }),
    async (p) => {
      const search = new URLSearchParams({ limit: "500" });
      const root = await dbtGet(
        `/accounts/${encodeURIComponent(String(p.accountId))}/jobs/?${search.toString()}`,
      );
      const matches = filterDbtJobs(dataFrom(root), { query: p.query, limit: p.limit });
      return jsonResult({ matches });
    },
  );
}
