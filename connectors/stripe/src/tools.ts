import { z } from "zod";
import { createJsonGetter, envAuthHeaders } from "../../../shared/env-json-api.ts";
import { matchesResult, searchToolInputSchema } from "../../../shared/mcp-search-tool.ts";
import { mcpJsonResult as jsonResult } from "../../../shared/mcp-tool-kit.ts";
import type { ZodToolRegistrar } from "../../../shared/run-read-only-mcp-connector.ts";
import { filterStripeInvoices } from "./search-filter.ts";

const BASE = "https://api.stripe.com";

const stripeGet = createJsonGetter({
  base: BASE,
  label: "Stripe",
  headers: envAuthHeaders({ env: "STRIPE_API_KEY" }),
});

/** Tool names exposed by this connector — for contract/introspection tests. */
export const STRIPE_TOOL_NAMES = ["stripe_get", "stripe_list", "stripe_search"] as const;

export function registerStripeTools(reg: ZodToolRegistrar): void {
  reg(
    "stripe_list",
    "List recent Stripe invoices (`GET /v1/invoices`), most-recent-first, capped at `limit` (default 100). Returns the `{ object: 'list', data, has_more }` envelope.",
    z.object({
      limit: z.number().int().min(1).max(100).optional(),
    }),
    async (p) => {
      const search = new URLSearchParams({ limit: String(p.limit ?? 100) });
      return jsonResult(await stripeGet(`/v1/invoices?${search.toString()}`));
    },
  );

  reg(
    "stripe_get",
    "Fetch one Stripe invoice by its id (`GET /v1/invoices/{id}`, e.g. `in_1A2b...`). Returns the invoice object directly. Throws when no match is found.",
    z.object({
      id: z.string().min(1),
    }),
    async (p) => {
      return jsonResult(await stripeGet(`/v1/invoices/${encodeURIComponent(p.id)}`));
    },
  );

  reg(
    "stripe_search",
    "Substring search across recent Stripe invoices. Matches the query against id, number, status, customer id, customer name, customer email, and the description (case-insensitive). Returns a `{ matches: [...] }` envelope.",
    searchToolInputSchema(100),
    async (p) => {
      const search = new URLSearchParams({ limit: "100" });
      const root = await stripeGet(`/v1/invoices?${search.toString()}`);
      const data = (root as { data?: unknown[] } | null)?.data;
      return matchesResult(data, filterStripeInvoices, p);
    },
  );
}
