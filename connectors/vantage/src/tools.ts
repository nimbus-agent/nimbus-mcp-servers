import { fetchWithTimeout } from "@nimbus-dev/sdk/connector-kit";
import { z } from "zod";
import { cursorListInputSchema } from "../../../shared/cursor-list-tool.ts";
import {
  createJsonGetter,
  envAuthHeaders,
  type JsonFetch,
  optionalEnv,
} from "../../../shared/env-json-api.ts";
import { matchesResult, searchToolInputSchema } from "../../../shared/mcp-search-tool.ts";
import { mcpJsonResult as jsonResult } from "../../../shared/mcp-tool-kit.ts";
import type { ZodToolRegistrar } from "../../../shared/run-read-only-mcp-connector.ts";
import { filterVantageRecommendations } from "./search-filter.ts";

/**
 * Vantage API v2 (https://api.vantage.sh/v2, OpenAPI 3.0.1). Read-only: every request is a GET.
 *
 * Every reply shape here was written from Vantage's published OpenAPI file, not from a live
 * account (UNVERIFIED against one). `Authorization: Bearer <token>` is from the authentication
 * docs page; the OpenAPI file declares only an `oauth2` scheme (UNVERIFIED against a live account).
 */
const API_BASE = "https://api.vantage.sh/v2";

/** The documented maximum page size of GET /costs and GET /recommendations. */
const COSTS_PAGE_LIMIT = 5000;
const RECOMMENDATIONS_PAGE_LIMIT = 1000;

/** The grouping applied when neither a saved report nor VANTAGE_GROUP_BY names one. */
const DEFAULT_GROUPINGS = "provider,service,account_id";

/** A page number the model may hand back: 1 to 999999, no sign, no leading zero. */
const PAGE_CURSOR = /^[1-9]\d{0,5}$/;

const MAX_EPOCH_MS = 253_402_300_799_999; // 9999-12-31T23:59:59.999Z

/** Tool names exposed by this connector — for contract/introspection tests. */
export const VANTAGE_TOOL_NAMES = [
  "vantage_cost_list",
  "vantage_recommendation_list",
  "vantage_cost_get",
  "vantage_search",
] as const;

/** The two clock seams a test replaces. */
export interface VantageDeps {
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
}

const realDeps: VantageDeps = {
  now: () => Date.now(),
  sleep: (ms) =>
    new Promise<void>((resolve) => {
      setTimeout(resolve, ms);
    }),
};

/** A cursor (null, absent, or the previous `nextCursor`) as the page to request. */
function pageFromCursor(cursor: string | null | undefined): number {
  if (cursor === undefined || cursor === null) {
    return 1;
  }
  if (!PAGE_CURSOR.test(cursor)) {
    throw new Error("cursor must be the nextCursor of a previous page (a page number)");
  }
  return Number(cursor);
}

/**
 * `{ items, nextCursor }` from a reply: `key`'s array untouched, and the next page number when
 * `links.next` is a non-empty string (R5). The link itself is never fetched.
 */
function pageResult(root: unknown, key: string, page: number): ReturnType<typeof jsonResult> {
  const body = root !== null && typeof root === "object" ? (root as Record<string, unknown>) : {};
  const rows = body[key];
  const links = body["links"];
  const next =
    links !== null && typeof links === "object" ? (links as Record<string, unknown>)["next"] : null;
  return jsonResult({
    items: Array.isArray(rows) ? rows : [],
    nextCursor: typeof next === "string" && next !== "" ? String(page + 1) : null,
  });
}

/** `YYYY-MM-DD` of `ms` in UTC. */
function utcDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** VANTAGE_GROUP_BY as the comma-joined list the API takes (R1): entries trimmed, empties dropped. */
function groupByFromEnv(): string {
  return optionalEnv("VANTAGE_GROUP_BY", "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "")
    .join(",");
}

/** The groupings to send: VANTAGE_GROUP_BY, else the saved report's (send none), else the default. */
function groupingsFor(reportToken: string): string | undefined {
  const fromEnv = groupByFromEnv();
  if (fromEnv !== "") {
    return fromEnv;
  }
  return reportToken === "" ? DEFAULT_GROUPINGS : undefined;
}

const costListSchema = z.object({
  cursor: z.string().nullable().optional(),
  limit: z.number().int().min(1).max(COSTS_PAGE_LIMIT).optional(),
  sinceMs: z.number().int().min(0).max(MAX_EPOCH_MS).optional(),
  untilMs: z.number().int().min(0).max(MAX_EPOCH_MS).optional(),
});

/** The transport handed to the JSON getter. */
function vantageFetch(_deps: VantageDeps): JsonFetch {
  return (url, init) => fetchWithTimeout(url, init);
}

export function registerVantageTools(reg: ZodToolRegistrar): void {
  registerVantageToolsWith(reg, realDeps);
}

/** {@link registerVantageTools} with the clock seams injected, for tests. */
export function registerVantageToolsWith(reg: ZodToolRegistrar, deps: VantageDeps): void {
  const vantageGet = createJsonGetter({
    base: API_BASE,
    label: "Vantage",
    headers: envAuthHeaders({ env: "VANTAGE_API_TOKEN" }),
    fetch: vantageFetch(deps),
  });

  reg(
    "vantage_cost_list",
    "List Vantage costs (`GET /costs`), binned by day, one page per call. `sinceMs` / `untilMs` (epoch milliseconds; UTC dates are sent) bound the range, and `untilMs` defaults to now. Rows are grouped by VANTAGE_GROUP_BY, else by the saved cost report's groupings when VANTAGE_COST_REPORT_TOKEN is set, else by provider, service and account_id. Returns `{ items, nextCursor }`: pass `nextCursor` back as `cursor` for the next page; it is null on the last page. At most one request per 1.2 s; the first 429 ends the call.",
    costListSchema,
    async (p) => {
      const page = pageFromCursor(p.cursor);
      const reportToken = optionalEnv("VANTAGE_COST_REPORT_TOKEN", "");
      const workspaceToken = optionalEnv("VANTAGE_WORKSPACE_TOKEN", "");
      const groupings = groupingsFor(reportToken);
      const search = new URLSearchParams();
      if (reportToken !== "") {
        search.set("cost_report_token", reportToken);
      }
      if (workspaceToken !== "") {
        search.set("workspace_token", workspaceToken);
      }
      if (p.sinceMs !== undefined) {
        search.set("start_date", utcDate(p.sinceMs));
      }
      search.set("end_date", utcDate(p.untilMs ?? deps.now()));
      search.set("date_bin", "day");
      if (groupings !== undefined) {
        search.set("groupings", groupings);
      }
      search.set("limit", String(p.limit ?? COSTS_PAGE_LIMIT));
      search.set("page", String(page));
      return pageResult(await vantageGet(`/costs?${search.toString()}`), "costs", page);
    },
  );

  /** The recommendations query: active only, in this workspace when VANTAGE_WORKSPACE_TOKEN is set. */
  const recommendationQuery = (limit: number, page?: number): string => {
    const search = new URLSearchParams({ status: "active", limit: String(limit) });
    const workspaceToken = optionalEnv("VANTAGE_WORKSPACE_TOKEN", "");
    if (workspaceToken !== "") {
      search.set("workspace_token", workspaceToken);
    }
    if (page !== undefined) {
      search.set("page", String(page));
    }
    return search.toString();
  };

  reg(
    "vantage_recommendation_list",
    "List Vantage's ACTIVE cost-saving recommendations (`GET /recommendations?status=active`), one page per call. Returns `{ items, nextCursor }`: pass `nextCursor` back as `cursor` for the next page; it is null on the last page. `potential_savings` is a monthly figure in the workspace's currency.",
    cursorListInputSchema(RECOMMENDATIONS_PAGE_LIMIT),
    async (p) => {
      const page = pageFromCursor(p.cursor);
      const query = recommendationQuery(p.limit ?? RECOMMENDATIONS_PAGE_LIMIT, page);
      return pageResult(await vantageGet(`/recommendations?${query}`), "recommendations", page);
    },
  );

  reg(
    "vantage_cost_get",
    "Fetch one Vantage cost report definition by token (`GET /cost_reports/{id}`): its title, workspace, saved groupings, filter and date range. Returns the raw Vantage body. Throws when no such report exists.",
    z.object({ id: z.string().min(1) }),
    async (p) => jsonResult(await vantageGet(`/cost_reports/${encodeURIComponent(p.id)}`)),
  );

  reg(
    "vantage_search",
    "Substring search across Vantage's first 1000 active recommendations. Matches the query against description, type, service, provider and category (case-insensitive). Returns a `{ matches: [...] }` envelope.",
    searchToolInputSchema(200),
    async (p) => {
      const root = await vantageGet(
        `/recommendations?${recommendationQuery(RECOMMENDATIONS_PAGE_LIMIT)}`,
      );
      const rows =
        root !== null && typeof root === "object"
          ? (root as Record<string, unknown>)["recommendations"]
          : undefined;
      return matchesResult(rows, filterVantageRecommendations, p);
    },
  );
}
