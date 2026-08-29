import { z } from "zod";
import { createJsonGetter } from "../../../shared/env-json-api.ts";
import { matchesResult, searchToolInputSchema } from "../../../shared/mcp-search-tool.ts";
import { mcpJsonResult as jsonResult } from "../../../shared/mcp-tool-kit.ts";
import type { ZodToolRegistrar } from "../../../shared/run-read-only-mcp-connector.ts";
import { filterIntercomConversations } from "./search-filter.ts";

const BASE = "https://api.intercom.io";

function apiToken(): string {
  const t = process.env["INTERCOM_TOKEN"]?.trim();
  if (t === undefined || t === "") {
    throw new Error("INTERCOM_TOKEN is not set");
  }
  return t;
}

function authHeader(): Record<string, string> {
  return {
    Authorization: `Bearer ${apiToken()}`,
    "Intercom-Version": "2.11",
    Accept: "application/json",
  };
}

const intercomGet = createJsonGetter({
  base: BASE,
  label: "Intercom",
  headers: authHeader,
});

/** Tool names exposed by this connector — for contract/introspection tests. */
export const INTERCOM_TOOL_NAMES = ["intercom_get", "intercom_list", "intercom_search"] as const;

export function registerIntercomTools(reg: ZodToolRegistrar): void {
  reg(
    "intercom_list",
    'List the user\'s Intercom conversations (`GET /conversations?per_page=150`). Returns the `{ type: "conversation.list", conversations: [...], pages, total_count }` envelope — `conversations` holds the conversation objects.',
    z.object({}),
    async () => {
      return jsonResult(await intercomGet(`/conversations?per_page=150`));
    },
  );

  reg(
    "intercom_get",
    "Fetch one Intercom conversation by its id (`GET /conversations/{id}` — note the PLURAL `conversations` in the get-by-id path). Returns the conversation object directly. Throws when no match is found.",
    z.object({
      id: z.string().min(1),
    }),
    async (p) => {
      return jsonResult(await intercomGet(`/conversations/${encodeURIComponent(p.id)}`));
    },
  );

  reg(
    "intercom_search",
    "Substring search across the user's Intercom conversations (first page only). Matches the query against the conversation subject, the source message body, the state, the source author name + email, and the tags (case-insensitive). Returns a `{ matches: [...] }` envelope.",
    searchToolInputSchema(100),
    async (p) => {
      const root = await intercomGet(`/conversations?per_page=150`);
      const conversations = (root as { conversations?: unknown[] } | null)?.conversations;
      return matchesResult(conversations, filterIntercomConversations, p);
    },
  );
}
