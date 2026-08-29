import { z } from "zod";
import { createJsonGetter } from "../../../shared/env-json-api.ts";
import { matchesResult, searchToolInputSchema } from "../../../shared/mcp-search-tool.ts";
import {
  encodeBasicAuthHeader,
  mcpJsonResult as jsonResult,
} from "../../../shared/mcp-tool-kit.ts";
import type { ZodToolRegistrar } from "../../../shared/run-read-only-mcp-connector.ts";
import { stripTrailingSlashes } from "../../../shared/strip-trailing-slashes.ts";
import { filterZendeskTickets } from "./search-filter.ts";

function baseUrl(): string {
  const v = process.env["ZENDESK_URL"]?.trim();
  if (v === undefined || v === "") {
    throw new Error("ZENDESK_URL is not set");
  }
  return stripTrailingSlashes(v);
}

function authHeader(): Record<string, string> {
  const email = process.env["ZENDESK_EMAIL"]?.trim();
  if (email === undefined || email === "") {
    throw new Error("ZENDESK_EMAIL is not set");
  }
  const token = process.env["ZENDESK_API_TOKEN"]?.trim();
  if (token === undefined || token === "") {
    throw new Error("ZENDESK_API_TOKEN is not set");
  }
  return {
    Authorization: encodeBasicAuthHeader(`${email}/token`, token),
    Accept: "application/json",
  };
}

const zendeskGet = createJsonGetter({
  base: baseUrl,
  label: "Zendesk",
  headers: authHeader,
});

/** Tool names exposed by this connector — for contract/introspection tests. */
export const ZENDESK_TOOL_NAMES = ["zendesk_get", "zendesk_list", "zendesk_search"] as const;

export function registerZendeskTools(reg: ZodToolRegistrar): void {
  reg(
    "zendesk_list",
    "List the user's Zendesk tickets (`GET /api/v2/tickets.json?page[size]=100`). Returns the cursor-pagination envelope `{ tickets: [...], meta: { has_more, after_cursor }, links: { next } }` — `tickets` holds the ticket objects.",
    z.object({}),
    async () => {
      return jsonResult(await zendeskGet(`/api/v2/tickets.json?page[size]=100`));
    },
  );

  reg(
    "zendesk_get",
    "Fetch one Zendesk ticket by its numeric id (`GET /api/v2/tickets/{id}.json`). Returns the `{ ticket: {...} }` envelope. Throws when no match is found.",
    z.object({
      id: z.string().min(1),
    }),
    async (p) => {
      return jsonResult(await zendeskGet(`/api/v2/tickets/${encodeURIComponent(p.id)}.json`));
    },
  );

  reg(
    "zendesk_search",
    "Substring search across the user's Zendesk tickets (first page only). Matches the query against the ticket subject, description, status, priority, type, and tags (case-insensitive). Returns a `{ matches: [...] }` envelope.",
    searchToolInputSchema(100),
    async (p) => {
      const root = await zendeskGet(`/api/v2/tickets.json?page[size]=100`);
      const tickets = (root as { tickets?: unknown[] } | null)?.tickets;
      return matchesResult(tickets, filterZendeskTickets, p);
    },
  );
}
