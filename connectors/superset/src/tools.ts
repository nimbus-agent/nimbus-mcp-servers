import { z } from "zod";
import { createAccessTokenCache } from "../../../shared/access-token-cache.ts";
import { requiredBaseUrl, requiredEnv } from "../../../shared/env-json-api.ts";
import { guardedFetch } from "../../../shared/guarded-fetch.ts";
import { searchToolInputSchema } from "../../../shared/mcp-search-tool.ts";
import { mcpJsonResult as jsonResult } from "../../../shared/mcp-tool-kit.ts";
import type { ZodToolRegistrar } from "../../../shared/run-read-only-mcp-connector.ts";
import { filterSupersetDashboards } from "./search-filter.ts";

function apiBase(): string {
  return requiredBaseUrl("SUPERSET_URL");
}

/** SUPERSET_URL names a self-hosted server, which has always been allowed plain http. */
const SELF_HOSTED = { requireSecureBase: false } as const;

/** Superset issues its own JWT from a username/password POST, not OAuth. */
const login = createAccessTokenCache({
  label: "Superset login",
  exchange: async () => {
    const username = requiredEnv("SUPERSET_USERNAME");
    const password = requiredEnv("SUPERSET_PASSWORD");
    // A 3xx on this POST is refused: the password must never be replayed to a redirect target.
    const res = await guardedFetch(
      "Superset",
      `${apiBase()}/api/v1/security/login`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ username, password, provider: "db", refresh: true }),
      },
      SELF_HOSTED,
    );
    return { ok: res.ok, status: res.status, text: await res.text() };
  },
});

/** Forget the login token. Tests only: the cache otherwise outlives the test that filled it. */
export function __resetSupersetLoginForTests(): void {
  login.clear();
}

async function supersetGet(path: string): Promise<unknown> {
  const token = await login();
  const res = await guardedFetch(
    "Superset",
    `${apiBase()}${path}`,
    { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } },
    SELF_HOSTED,
  );
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
