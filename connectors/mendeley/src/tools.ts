import { z } from "zod";
import { createJsonGetter, envAuthHeaders } from "../../../shared/env-json-api.ts";
import { matchesResult } from "../../../shared/mcp-search-tool.ts";
import { mcpJsonResult as jsonResult } from "../../../shared/mcp-tool-kit.ts";
import type { ZodToolRegistrar } from "../../../shared/run-read-only-mcp-connector.ts";
import { filterMendeleyDocuments } from "./search-filter.ts";

const BASE = "https://api.mendeley.com";
const DOC_ACCEPT = "application/vnd.mendeley-document.1+json";

/**
 * Failures carry the HTTP status (`Mendeley <status>: …`) so an expired token (401) surfaces
 * explicitly to the gateway client; the same error shape as the zotero connector's.
 */
const mendeleyGet = createJsonGetter({
  base: BASE,
  label: "Mendeley",
  // `extra` replaces the default `Accept` in place: Mendeley serves documents under its own
  // vendor media type.
  headers: envAuthHeaders({ env: "MENDELEY_ACCESS_TOKEN", extra: { Accept: DOC_ACCEPT } }),
});

/** Tool names exposed by this connector — for contract/introspection tests. */
export const MENDELEY_TOOL_NAMES = ["mendeley_get", "mendeley_list", "mendeley_search"] as const;

export function registerMendeleyTools(reg: ZodToolRegistrar): void {
  reg(
    "mendeley_list",
    "List the user's Mendeley library documents (`GET /documents?view=all&limit=100`). Returns the raw JSON array of document objects — each is `{ id, title, type, authors, year, source, identifiers: { doi, ... }, keywords, abstract, last_modified, websites, ... }`.",
    z.object({}),
    async () => {
      return jsonResult(await mendeleyGet(`/documents?view=all&limit=100`));
    },
  );

  reg(
    "mendeley_get",
    "Fetch one Mendeley document by its id (`GET /documents/{id}?view=all`). Returns the document object directly (NOT wrapped in an array). Throws when no match is found.",
    z.object({ id: z.string().min(1) }),
    async (p) => {
      return jsonResult(await mendeleyGet(`/documents/${encodeURIComponent(p.id)}?view=all`));
    },
  );

  reg(
    "mendeley_search",
    "Substring search across the first page of the user's library documents. Matches the query against the title, document type, abstract, source, DOI, formatted author names, and keywords (case-insensitive). Returns a `{ matches: [...] }` envelope.",
    z.object({ query: z.string().min(1), limit: z.number().int().min(1).max(100).optional() }),
    async (p) => {
      const root = await mendeleyGet(`/documents?view=all&limit=100`);
      return matchesResult(root, filterMendeleyDocuments, p);
    },
  );
}
