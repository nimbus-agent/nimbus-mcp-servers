import { z } from "zod";
import { createJsonGetter } from "../../../shared/env-json-api.ts";
import { matchesResult, searchToolInputSchema } from "../../../shared/mcp-search-tool.ts";
import {
  encodeBasicAuthHeader,
  mcpJsonResult as jsonResult,
} from "../../../shared/mcp-tool-kit.ts";
import type { ZodToolRegistrar } from "../../../shared/run-read-only-mcp-connector.ts";
import { filterLeverPostings } from "./search-filter.ts";

const BASE = "https://api.lever.co";

function apiKey(): string {
  const t = process.env["LEVER_API_KEY"]?.trim();
  if (t === undefined || t === "") {
    throw new Error("LEVER_API_KEY is not set");
  }
  return t;
}

function authHeader(): Record<string, string> {
  return { Authorization: encodeBasicAuthHeader(apiKey(), ""), Accept: "application/json" };
}

const leverGet = createJsonGetter({
  base: BASE,
  label: "Lever",
  headers: authHeader,
});

/** Tool names exposed by this connector — for contract/introspection tests. */
export const LEVER_TOOL_NAMES = ["lever_get", "lever_list", "lever_search"] as const;

export function registerLeverTools(reg: ZodToolRegistrar): void {
  reg(
    "lever_list",
    "List the company's published Lever job postings (`GET /v1/postings?limit=100`). Returns the offset-cursor envelope `{ data: [...], hasNext: boolean, next?: string }` — `data` holds the posting objects.",
    z.object({}),
    async () => {
      return jsonResult(await leverGet(`/v1/postings?limit=100`));
    },
  );

  reg(
    "lever_get",
    "Fetch one Lever job posting by its id (`GET /v1/postings/{id}`). Returns the `{ data: {...} }` envelope. Throws when no match is found.",
    z.object({
      id: z.string().min(1),
    }),
    async (p) => {
      return jsonResult(await leverGet(`/v1/postings/${encodeURIComponent(p.id)}`));
    },
  );

  reg(
    "lever_search",
    "Substring search across the company's Lever job postings (first page only). Matches the query against the posting text (title), state, and the team/department/location categories and tags (case-insensitive). Returns a `{ matches: [...] }` envelope.",
    searchToolInputSchema(100),
    async (p) => {
      const root = await leverGet(`/v1/postings?limit=100`);
      const data = (root as { data?: unknown[] } | null)?.data;
      return matchesResult(data, filterLeverPostings, p);
    },
  );
}
