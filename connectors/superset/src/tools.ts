import { z } from "zod";
import { createAccessTokenCache } from "../../../shared/access-token-cache.ts";
import { searchToolInputSchema } from "../../../shared/mcp-search-tool.ts";
import { mcpJsonResult as jsonResult } from "../../../shared/mcp-tool-kit.ts";
import type { ZodToolRegistrar } from "../../../shared/run-read-only-mcp-connector.ts";
import { stripTrailingSlashes } from "../../../shared/strip-trailing-slashes.ts";
import { filterSupersetDashboards } from "./search-filter.ts";

function apiBase(): string {
  const v = process.env["SUPERSET_URL"]?.trim();
  if (v === undefined || v === "") {
    throw new Error("SUPERSET_URL is not set");
  }
  return stripTrailingSlashes(v);
}

function requiredEnv(name: string): string {
  const v = process.env[name]?.trim();
  if (v === undefined || v === "") {
    throw new Error(`${name} is not set`);
  }
  return v;
}

/** Superset issues its own JWT from a username/password POST, not OAuth. */
const login = createAccessTokenCache({
  label: "Superset login",
  exchange: async () => {
    const username = requiredEnv("SUPERSET_USERNAME");
    const password = requiredEnv("SUPERSET_PASSWORD");
    const res = await fetch(`${apiBase()}/api/v1/security/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ username, password, provider: "db", refresh: true }),
    });
    return { ok: res.ok, status: res.status, text: await res.text() };
  },
});

async function supersetGet(path: string): Promise<unknown> {
  const token = await login();
  const res = await fetch(`${apiBase()}${path}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Superset ${String(res.status)}: ${text.slice(0, 400)}`);
  }
  return JSON.parse(text) as unknown;
}

function dashboardsFrom(root: unknown): unknown[] {
  const result = (root as { result?: unknown } | null)?.result;
  if (Array.isArray(result)) {
    return result;
  }
  return Array.isArray(root) ? root : [];
}

function dashboardListPath(page: number, pageSize: number): string {
  const q = encodeURIComponent(`(page:${String(page)},page_size:${String(pageSize)})`);
  return `/api/v1/dashboard/?q=${q}`;
}

/** Tool names exposed by this connector — for contract/introspection tests. */
export const SUPERSET_TOOL_NAMES = ["superset_get", "superset_list", "superset_search"] as const;

export function registerSupersetTools(reg: ZodToolRegistrar): void {
  reg(
    "superset_list",
    "List Apache Superset dashboards (`GET /api/v1/dashboard/`). `limit` (default 100) caps the page_size of the single first-page request. Returns the `.result` array from the Superset envelope.",
    z.object({
      limit: z.number().int().min(1).max(500).optional(),
    }),
    async (p) => {
      const root = await supersetGet(dashboardListPath(0, p.limit ?? 100));
      return jsonResult(dashboardsFrom(root));
    },
  );

  reg(
    "superset_get",
    "Fetch one Apache Superset dashboard by numeric id (`/api/v1/dashboard/{id}`). Throws when no dashboard with that id exists.",
    z.object({
      id: z.number().int(),
    }),
    async (p) => {
      return jsonResult(await supersetGet(`/api/v1/dashboard/${encodeURIComponent(String(p.id))}`));
    },
  );

  reg(
    "superset_search",
    "Substring search across Apache Superset dashboards. Matches the query (case-insensitive) against dashboard title and slug. Returns a `{ matches: [...] }` envelope.",
    searchToolInputSchema(200),
    async (p) => {
      const root = await supersetGet(dashboardListPath(0, 500));
      const matches = filterSupersetDashboards(dashboardsFrom(root), {
        query: p.query,
        limit: p.limit,
      });
      return jsonResult({ matches });
    },
  );
}
