import { z } from "zod";
import { createJsonGetter, envAuthHeaders } from "../../../shared/env-json-api.ts";
import { matchesResult, searchToolInputSchema } from "../../../shared/mcp-search-tool.ts";
import { mcpJsonResult as jsonResult } from "../../../shared/mcp-tool-kit.ts";
import type { ZodToolRegistrar } from "../../../shared/run-read-only-mcp-connector.ts";
import { filterStackOverflowQuestions } from "./search-filter.ts";

const BASE = "https://api.stackoverflowteams.com";

function teamSlug(): string {
  const t = process.env["STACKOVERFLOW_TEAM"]?.trim();
  if (t === undefined || t === "") {
    throw new Error("STACKOVERFLOW_TEAM is not set");
  }
  return t;
}

const stackOverflowGet = createJsonGetter({
  base: BASE,
  label: "Stack Overflow",
  headers: envAuthHeaders({ env: "STACKOVERFLOW_TOKEN" }),
});

function questionsBasePath(): string {
  return `/v3/teams/${encodeURIComponent(teamSlug())}/questions`;
}

/** Tool names exposed by this connector — for contract/introspection tests. */
export const STACKOVERFLOW_TOOL_NAMES = [
  "stackoverflow_list",
  "stackoverflow_get",
  "stackoverflow_search",
] as const;

export function registerStackoverflowTools(reg: ZodToolRegistrar): void {
  reg(
    "stackoverflow_list",
    "List the team's Stack Overflow for Teams questions (`GET /v3/teams/<team>/questions?page=1&pagesize=100&sort=creation&order=desc`). Returns the `{ items: [...], totalCount, pageSize, page, totalPages, sort, order }` envelope — `items` holds the question objects.",
    z.object({}),
    async () => {
      return jsonResult(
        await stackOverflowGet(
          `${questionsBasePath()}?page=1&pagesize=100&sort=creation&order=desc`,
        ),
      );
    },
  );

  reg(
    "stackoverflow_get",
    "Fetch one Stack Overflow for Teams question by its id (`GET /v3/teams/<team>/questions/{id}`). Returns the question object directly (NOT wrapped in an `{ items }` envelope). Throws when no match is found.",
    z.object({
      id: z.string().min(1),
    }),
    async (p) => {
      return jsonResult(
        await stackOverflowGet(`${questionsBasePath()}/${encodeURIComponent(p.id)}`),
      );
    },
  );

  reg(
    "stackoverflow_search",
    "Substring search across the team's Stack Overflow for Teams questions (first page only). Matches the query against the question title, body, tags, and the asking user's name (case-insensitive). Returns a `{ matches: [...] }` envelope.",
    searchToolInputSchema(100),
    async (p) => {
      const root = await stackOverflowGet(
        `${questionsBasePath()}?page=1&pagesize=100&sort=creation&order=desc`,
      );
      const items = (root as { items?: unknown[] } | null)?.items;
      return matchesResult(items, filterStackOverflowQuestions, p);
    },
  );
}
