import { z } from "zod";
import { type ConsentServer, createWriteToolRegistrar } from "../../../shared/consent-kit.ts";
import { envAuthHeaders, requiredEnv } from "../../../shared/env-json-api.ts";
import { searchToolInputSchema } from "../../../shared/mcp-search-tool.ts";
import { fetchWithTimeout, mcpJsonResult as jsonResult } from "../../../shared/mcp-tool-kit.ts";
import {
  runReadOnlyMcpConnector,
  type ZodToolRegistrar,
} from "../../../shared/run-read-only-mcp-connector.ts";
import { filterBigeyeIssues } from "./search-filter.ts";

/** Only ONE trailing slash is dropped here — not `requiredBaseUrl`'s strip-them-all. */
function apiBase(): string {
  const v = requiredEnv("BIGEYE_BASE_URL");
  return v.endsWith("/") ? v.slice(0, -1) : v;
}

const authHeader = envAuthHeaders({ env: "BIGEYE_API_KEY" });

/** One page of issues (`GET /api/v1/issues?limit&offset`), tolerant of array / `{issues}` / `{data}`. */
async function fetchIssues(limit: number, offset: number): Promise<unknown[]> {
  const url = `${apiBase()}/api/v1/issues?limit=${String(limit)}&offset=${String(offset)}`;
  const res = await fetchWithTimeout(url, { headers: authHeader() });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Bigeye ${String(res.status)}: ${text.slice(0, 400)}`);
  }
  const parsed = JSON.parse(text) as unknown;
  if (Array.isArray(parsed)) {
    return parsed;
  }
  if (parsed !== null && typeof parsed === "object") {
    const root = parsed as Record<string, unknown>;
    if (Array.isArray(root["issues"])) return root["issues"];
    if (Array.isArray(root["data"])) return root["data"];
  }
  return [];
}

function issueId(item: unknown): string {
  if (item === null || typeof item !== "object" || Array.isArray(item)) return "";
  const row = item as Record<string, unknown>;
  const v = row["id"];
  if (typeof v === "string") return v;
  if (typeof v === "number") return String(v);
  return "";
}

/** Update a Bigeye issue status via `POST /api/v1/issues`. */
async function updateIssueStatus(issueId: string, status: string): Promise<void> {
  const base = apiBase();
  const res = await fetchWithTimeout(`${base}/api/v1/issues`, {
    method: "POST",
    headers: { ...authHeader(), "Content-Type": "application/json" },
    body: JSON.stringify({ issueId, status }),
  });
  if (!res.ok) {
    throw new Error(
      `Bigeye updateIssue ${String(res.status)}: ${(await res.text()).slice(0, 400)}`,
    );
  }
}

export function registerBigeyeTools(reg: ZodToolRegistrar, server: unknown): void {
  // Despite the read-only helper's name, this connector exposes write tools. The consent
  // kit needs the real server, which the helper now passes through as its second argument.
  const registerWriteTool = createWriteToolRegistrar(server as ConsentServer, {
    connector: "bigeye",
    scopeEnv: "NIMBUS_MCP_BIGEYE_WRITE_SCOPE",
    scopeKinds: ["issue"],
  });

  reg(
    "bigeye_list",
    "List Bigeye data-quality issues (`GET /api/v1/issues`). Paginated: `cursor` (offset) + `limit` (default 200, max 500) → `{ items, nextCursor }`.",
    z.object({
      cursor: z.string().nullable().optional(),
      limit: z.number().int().min(1).max(500).optional(),
    }),
    async (p) => {
      const limit = p.limit ?? 200;
      // null / undefined / "" / non-numeric / negative all clamp to offset 0; fractional truncates.
      const offset = Math.max(0, Math.trunc(Number(p.cursor) || 0));
      const issues = await fetchIssues(limit, offset);
      const nextCursor = issues.length === limit ? String(offset + limit) : null;
      return jsonResult({ items: issues, nextCursor });
    },
  );

  reg(
    "bigeye_get",
    "Fetch one Bigeye data-quality issue by its id. Throws when the issue is not found.",
    z.object({
      id: z.string().min(1),
    }),
    async (p) => {
      const issues = await fetchIssues(500, 0);
      const found = issues.find((item) => issueId(item) === p.id);
      if (found === undefined) {
        throw new Error(`Bigeye issue not found: ${p.id}`);
      }
      return jsonResult(found);
    },
  );

  reg(
    "bigeye_search",
    "Substring search across Bigeye data-quality issues. Matches the query (case-insensitive) against issue summary, title, and description. Returns a `{ matches: [...] }` envelope.",
    searchToolInputSchema(200),
    async (p) => {
      const issues = await fetchIssues(500, 0);
      const matches = filterBigeyeIssues(issues, { query: p.query, limit: p.limit });
      return jsonResult({ matches });
    },
  );

  /**
   * Acknowledge and resolve are ONE mutation, `updateIssueStatus`, with a different status, so
   * they share everything except their name, action type, description and that status.
   */
  function registerStatusTool(
    name: string,
    mutates: string,
    description: string,
    status: "ISSUE_STATUS_ACKNOWLEDGED" | "ISSUE_STATUS_CLOSED",
  ): void {
    registerWriteTool(
      name,
      {
        mutates,
        recoverable: true,
        scopeTargetOf: (p) => ({ kind: "issue", value: p.issueId }),
      },
      description,
      z.object({ issueId: z.string().min(1) }),
      async (p) => {
        await updateIssueStatus(p.issueId, status);
        return jsonResult({ status: "ok", issueId: p.issueId });
      },
    );
  }

  registerStatusTool(
    "bigeye_issue_acknowledge",
    "bigeye.issue.acknowledge",
    "Acknowledge a Bigeye issue.",
    "ISSUE_STATUS_ACKNOWLEDGED",
  );
  registerStatusTool(
    "bigeye_issue_resolve",
    "bigeye.issue.resolve",
    "Resolve (close) a Bigeye issue.",
    "ISSUE_STATUS_CLOSED",
  );
}

// Exported so the bundled-connector registry can start this server explicitly: `import.meta.main`
// is false under an import, and the module must stay importable by tests without connecting stdio.
export async function startConnector(): Promise<void> {
  await runReadOnlyMcpConnector("nimbus-bigeye", registerBigeyeTools);
}

if (import.meta.main) await startConnector();
