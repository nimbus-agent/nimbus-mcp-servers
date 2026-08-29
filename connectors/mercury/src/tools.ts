import { z } from "zod";
import { createJsonGetter, envAuthHeaders } from "../../../shared/env-json-api.ts";
import { matchesResult, searchToolInputSchema } from "../../../shared/mcp-search-tool.ts";
import { mcpJsonResult as jsonResult } from "../../../shared/mcp-tool-kit.ts";
import type { ZodToolRegistrar } from "../../../shared/run-read-only-mcp-connector.ts";
import { filterMercuryAccounts } from "./search-filter.ts";

const BASE = "https://api.mercury.com";

const mercuryGet = createJsonGetter({
  base: BASE,
  label: "Mercury",
  headers: envAuthHeaders({ env: "MERCURY_TOKEN" }),
});

/** Tool names exposed by this connector — for contract/introspection tests. */
export const MERCURY_TOOL_NAMES = ["mercury_get", "mercury_list", "mercury_search"] as const;

export function registerMercuryTools(reg: ZodToolRegistrar): void {
  reg(
    "mercury_list",
    "List the user's Mercury bank accounts (`GET /api/v1/accounts`). Returns the `{ accounts: [...] }` envelope. There is no pagination — Mercury returns the full account list in one call.",
    z.object({}),
    async () => {
      return jsonResult(await mercuryGet(`/api/v1/accounts`));
    },
  );

  reg(
    "mercury_get",
    "Fetch one Mercury account by its id (`GET /api/v1/account/{id}`, note the singular `account` in the path). Returns the account object directly. Throws when no match is found.",
    z.object({
      id: z.string().min(1),
    }),
    async (p) => {
      return jsonResult(await mercuryGet(`/api/v1/account/${encodeURIComponent(p.id)}`));
    },
  );

  reg(
    "mercury_search",
    "Substring search across the user's Mercury accounts. Matches the query against id, name, status, type, kind, and the legal business name (case-insensitive). Returns a `{ matches: [...] }` envelope.",
    searchToolInputSchema(100),
    async (p) => {
      const root = await mercuryGet(`/api/v1/accounts`);
      const accounts = (root as { accounts?: unknown[] } | null)?.accounts;
      return matchesResult(accounts, filterMercuryAccounts, p);
    },
  );
}
