import {
  type CollectionToolsConfig,
  collectionToolNames,
  envelopeRows,
  registerCollectionTools,
} from "../../../shared/collection-tool-kit.ts";
import { createJsonGetter, envAuthHeaders } from "../../../shared/env-json-api.ts";
import type { ZodToolRegistrar } from "../../../shared/run-read-only-mcp-connector.ts";
import { filterReadwiseBooks, filterReadwiseHighlights } from "./search-filter.ts";

const BASE = "https://readwise.io";
const HIGHLIGHTS = "/api/v2/highlights/?page_size=1000";
const BOOKS = "/api/v2/books/?page_size=1000";

/** Readwise authenticates with `Authorization: Token <key>`, not Bearer. */
const readwiseGet = createJsonGetter({
  base: BASE,
  label: "Readwise",
  headers: envAuthHeaders({ env: "READWISE_TOKEN", scheme: "Token" }),
});

/**
 * Readwise exposes two collections with separate id spaces. Both are the plain
 * list/get/search triple, so both are declarations rather than hand-written
 * handlers; only the books collection needs non-default tool names.
 */
const HIGHLIGHT_TOOLS: CollectionToolsConfig = {
  prefix: "readwise",
  get: readwiseGet,
  list: {
    path: HIGHLIGHTS,
    description:
      "List the user's Readwise highlights (`GET /api/v2/highlights/?page_size=1000`). Returns the DRF `{ count, next, previous, results: [...] }` envelope — `results` holds the highlight objects and `next` is the next-page URL (null on the last page).",
  },
  item: {
    path: (id) => `/api/v2/highlights/${id}/`,
    description:
      "Fetch one Readwise highlight by its id (`GET /api/v2/highlights/{id}/`). Returns the highlight object directly. Throws when no match is found.",
  },
  search: {
    description:
      "Substring search across the user's Readwise highlights (first page only). Matches the query against the highlight text, the user's note, color, location_type, and tag names (case-insensitive). Returns a `{ matches: [...] }` envelope.",
    rows: envelopeRows("results"),
    filter: filterReadwiseHighlights,
  },
};

const BOOK_TOOLS: CollectionToolsConfig = {
  prefix: "readwise",
  get: readwiseGet,
  list: {
    path: BOOKS,
    tool: "books_list",
    description:
      "List the user's Readwise books/articles (`GET /api/v2/books/?page_size=1000`) — the parent records a highlight's `book_id` points at. Returns the same DRF `{ count, next, previous, results: [...] }` envelope as `readwise_list`; `results` holds the book objects (`id`, `title`, `author`, `category`, `source`, `num_highlights`, `highlights_url`, `source_url`, `asin`, `tags`, `document_note`).",
  },
  item: {
    path: (id) => `/api/v2/books/${id}/`,
    tool: "book_get",
    description:
      "Fetch one Readwise book/article by its id (`GET /api/v2/books/{id}/`). Note the id space is SEPARATE from the highlight id space — pass a highlight's `book_id`, not its `id`. Returns the book object directly. Throws when no match is found.",
  },
  search: {
    tool: "books_search",
    description:
      "Substring search across the user's Readwise books/articles (first page only). Matches the query against the title, author, category, source, the user's document note, and tag names (case-insensitive). Returns a `{ matches: [...] }` envelope.",
    rows: envelopeRows("results"),
    filter: filterReadwiseBooks,
  },
};

/** Tool names exposed by this connector — for contract/introspection tests. */
export const READWISE_TOOL_NAMES = [
  ...collectionToolNames(HIGHLIGHT_TOOLS),
  ...collectionToolNames(BOOK_TOOLS),
] as const;

export function registerReadwiseTools(reg: ZodToolRegistrar): void {
  registerCollectionTools(reg, HIGHLIGHT_TOOLS);
  registerCollectionTools(reg, BOOK_TOOLS);
}
