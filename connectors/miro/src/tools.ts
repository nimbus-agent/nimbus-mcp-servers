import { z } from "zod";
import { createJsonGetter, envAuthHeaders } from "../../../shared/env-json-api.ts";
import { searchToolInputSchema } from "../../../shared/mcp-search-tool.ts";
import { mcpJsonResult as jsonResult } from "../../../shared/mcp-tool-kit.ts";
import type { ZodToolRegistrar } from "../../../shared/run-read-only-mcp-connector.ts";
import { filterMiroBoards } from "./search-filter.ts";

const BASE = "https://api.miro.com";

const miroGet = createJsonGetter({
  base: BASE,
  label: "Miro",
  headers: envAuthHeaders({ env: "MIRO_TOKEN" }),
});

function boardsFrom(root: unknown): unknown[] {
  const data = (root as { data?: unknown } | null)?.data;
  return Array.isArray(data) ? data : [];
}

/** Tool names exposed by this connector — for contract/introspection tests. */
export const MIRO_TOOL_NAMES = ["miro_get", "miro_list", "miro_search"] as const;

export function registerMiroTools(reg: ZodToolRegistrar): void {
  reg(
    "miro_list",
    "List the authenticated user's Miro boards (GET /v2/boards?limit=N&cursor=<cursor>). Returns the { data: [...], cursor?, total, size } envelope — `data` holds the board objects, each shaped { id, name, description, createdAt, modifiedAt, owner: { name }, viewLink, ... }; `cursor` (when present) is the opaque token for the next page. `limit` (default 50, max 50) caps the page_size of the single first-page request.",
    z.object({
      limit: z.number().int().min(1).max(50).optional(),
      cursor: z.string().optional(),
    }),
    async (p) => {
      const params = new URLSearchParams({ limit: String(p.limit ?? 50) });
      if (p.cursor !== undefined && p.cursor !== "") {
        params.set("cursor", p.cursor);
      }
      return jsonResult(await miroGet(`/v2/boards?${params.toString()}`));
    },
  );

  reg(
    "miro_get",
    "Fetch one Miro board by its id (GET /v2/boards/{boardId}). Returns the board object directly (NOT wrapped in `data`). Throws when no board with that id exists.",
    z.object({
      id: z.string().min(1),
    }),
    async (p) => {
      return jsonResult(await miroGet(`/v2/boards/${encodeURIComponent(p.id)}`));
    },
  );

  reg(
    "miro_search",
    "**Substring search over the FIRST PAGE only** (up to 50 most-recently-listed boards) of the authenticated user's Miro boards. This tool fetches GET /v2/boards?limit=50 once and matches the query locally (case-insensitive) against the board name, description, and owner name. **Boards beyond the first page are not searchable here — query the local Nimbus index instead for full coverage.** Returns a { matches: [...] } envelope.",
    searchToolInputSchema(50),
    async (p) => {
      const root = await miroGet("/v2/boards?limit=50");
      const matches = filterMiroBoards(boardsFrom(root), {
        query: p.query,
        limit: p.limit,
      });
      return jsonResult({ matches });
    },
  );
}
