/**
 * Parity with the gateway's bundled Readwise mappers (Nimbus `packages/gateway/src/connectors/
 * readwise-{highlight,book}-mapping.ts` at origin/main 61e034a5). Every case of their tests is here:
 * the same inputs, and the full expected row each one produced, field by field. A migrated user's
 * rows are updated IN PLACE only when `type` and `externalId` are byte-identical, and every other
 * field must match or the first extension sync rewrites the user's index.
 *
 * Each item must carry exactly the eight fields below: `service` and `syncedAt` belong to the
 * gateway, which drops them from an extension's item.
 */
import { describe, expect, test } from "bun:test";
import { mapReadwiseBookToItem } from "../src/book-mapping.ts";
import { mapReadwiseHighlightToItem } from "../src/highlight-mapping.ts";

const NOW = 1_700_009_999_999;
const CTX = { syncedAt: NOW };

const ITEM_FIELDS = [
  "bodyPreview",
  "canonicalUrl",
  "externalId",
  "metadata",
  "modifiedAt",
  "title",
  "type",
  "url",
] as const;

interface ExpectedRow {
  readonly type: string;
  readonly externalId: string;
  readonly title: string;
  readonly bodyPreview: string;
  readonly url: string | null;
  readonly canonicalUrl: string | null;
  readonly modifiedAt: number;
  readonly metadata: Record<string, unknown>;
}

interface ParityCase {
  readonly name: string;
  readonly input: unknown;
  /** `null` when the gateway mapper skipped the row. */
  readonly expected: ExpectedRow | null;
}

function assertParity(actual: unknown, expected: ExpectedRow | null): void {
  if (expected === null) {
    expect(actual).toBeNull();
    return;
  }
  if (actual === null || typeof actual !== "object") {
    throw new Error(`expected a mapped row, got ${String(actual)}`);
  }
  // Exactly the eight item fields: no `service`, no `syncedAt`, nothing else.
  expect(Object.keys(actual).sort()).toEqual([...ITEM_FIELDS]);
  expect(actual).toStrictEqual(expected);
}

function without(row: Record<string, unknown>, ...keys: string[]): Record<string, unknown> {
  const copy = { ...row };
  for (const k of keys) {
    delete copy[k];
  }
  return copy;
}

// ─── Highlights ──────────────────────────────────────────────────────────────

const HIGHLIGHTED_ISO = "2024-03-01T12:00:00.000Z";
const HIGHLIGHTED_MS = 1_709_294_400_000;
const UPDATED_ISO = "2024-03-02T08:00:00.000Z";
const UPDATED_MS = 1_709_366_400_000;
const TEXT = "Exponential backoff with jitter avoids thundering-herd retries";
const NOTE = "Use full jitter for queue workers";
const ARTICLE = "https://example.com/article";

function makeHighlight(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 123456,
    text: TEXT,
    note: NOTE,
    location: 42,
    location_type: "location",
    color: "yellow",
    book_id: 9001,
    url: ARTICLE,
    tags: [
      { id: 1, name: "reliability" },
      { id: 2, name: "retries" },
    ],
    highlighted_at: HIGHLIGHTED_ISO,
    updated: UPDATED_ISO,
    ...over,
  };
}

const HIGHLIGHT_META: Record<string, unknown> = {
  highlight_id: "123456",
  text: TEXT,
  note: NOTE,
  book_id: 9001,
  location: 42,
  location_type: "location",
  color: "yellow",
  tags: ["reliability", "retries"],
  source_url: ARTICLE,
  highlighted_at: HIGHLIGHTED_MS,
  updated_at: UPDATED_MS,
  canonical_url: ARTICLE,
};

const HIGHLIGHT_ROW: ExpectedRow = {
  type: "highlight",
  externalId: "123456",
  title: TEXT,
  bodyPreview: NOTE,
  url: ARTICLE,
  canonicalUrl: ARTICLE,
  modifiedAt: UPDATED_MS,
  metadata: HIGHLIGHT_META,
};

function highlightRow(over: Partial<ExpectedRow>, meta: Record<string, unknown> = {}): ExpectedRow {
  return { ...HIGHLIGHT_ROW, ...over, metadata: { ...HIGHLIGHT_META, ...meta } };
}

const NO_URL = { url: null, canonicalUrl: null } as const;
const NO_URL_META = { source_url: null, canonical_url: null } as const;

const HIGHLIGHT_CASES: readonly ParityCase[] = [
  { name: "null is skipped", input: null, expected: null },
  { name: "a string is skipped", input: "nope", expected: null },
  { name: "a number is skipped", input: 42, expected: null },
  { name: "a missing id is skipped", input: without(makeHighlight(), "id"), expected: null },
  { name: "a string id is skipped", input: makeHighlight({ id: "123" }), expected: null },
  { name: "the full highlight", input: makeHighlight(), expected: HIGHLIGHT_ROW },
  {
    name: "text over 80 chars is truncated to 80 + ellipsis in the title",
    input: makeHighlight({ text: "x".repeat(200) }),
    expected: highlightRow({ title: `${"x".repeat(80)}…` }, { text: "x".repeat(200) }),
  },
  {
    name: "the title is the trimmed text",
    input: makeHighlight({ text: "   hi there   " }),
    expected: highlightRow({ title: "hi there" }, { text: "   hi there   " }),
  },
  {
    name: "missing text: title `Highlight <id>`, preview still the note",
    input: without(makeHighlight(), "text"),
    expected: highlightRow({ title: "Highlight 123456" }, { text: null }),
  },
  {
    name: "blank text: title `Highlight <id>`",
    input: makeHighlight({ text: "   " }),
    expected: highlightRow({ title: "Highlight 123456" }, { text: "   " }),
  },
  {
    name: "missing note: preview falls back to the text",
    input: without(makeHighlight(), "note"),
    expected: highlightRow({ bodyPreview: TEXT }, { note: null }),
  },
  {
    name: "empty note: preview falls back to the text",
    input: makeHighlight({ note: "" }),
    expected: highlightRow({ bodyPreview: TEXT }, { note: "" }),
  },
  {
    name: "no updated: modifiedAt is highlighted_at",
    input: without(makeHighlight(), "updated"),
    expected: highlightRow({ modifiedAt: HIGHLIGHTED_MS }, { updated_at: null }),
  },
  {
    name: "no timestamps: modifiedAt is the walk's now",
    input: without(makeHighlight(), "updated", "highlighted_at"),
    expected: highlightRow({ modifiedAt: NOW }, { updated_at: null, highlighted_at: null }),
  },
  {
    name: "a null source url: no url",
    input: makeHighlight({ url: null }),
    expected: highlightRow(NO_URL, NO_URL_META),
  },
  {
    name: "a missing source url: no url",
    input: without(makeHighlight(), "url"),
    expected: highlightRow(NO_URL, NO_URL_META),
  },
  {
    name: "an empty source url: no url",
    input: makeHighlight({ url: "" }),
    expected: highlightRow(NO_URL, NO_URL_META),
  },
  {
    name: "missing optional fields pass through as null; tags as []",
    input: without(
      makeHighlight(),
      "note",
      "location",
      "location_type",
      "color",
      "book_id",
      "tags",
    ),
    expected: highlightRow(
      { bodyPreview: TEXT },
      { note: null, location: null, location_type: null, color: null, book_id: null, tags: [] },
    ),
  },
  {
    name: "tags: only the non-empty names of object entries",
    input: makeHighlight({
      tags: [null, 7, "x", { id: 1 }, { id: 2, name: "" }, { id: 3, name: "ok" }],
    }),
    expected: highlightRow({}, { tags: ["ok"] }),
  },
  {
    name: "tags: a non-array is []",
    input: makeHighlight({ tags: "nope" }),
    expected: highlightRow({}, { tags: [] }),
  },
  {
    name: "a bare highlight sharing a book's numeric id keeps the bare externalId",
    input: { id: 9001, text: "a highlight that happens to share the book's numeric id" },
    expected: {
      type: "highlight",
      externalId: "9001",
      title: "a highlight that happens to share the book's numeric id",
      bodyPreview: "a highlight that happens to share the book's numeric id",
      url: null,
      canonicalUrl: null,
      modifiedAt: NOW,
      metadata: {
        highlight_id: "9001",
        text: "a highlight that happens to share the book's numeric id",
        note: null,
        book_id: null,
        location: null,
        location_type: null,
        color: null,
        tags: [],
        source_url: null,
        highlighted_at: null,
        updated_at: null,
        canonical_url: null,
      },
    },
  },
  {
    name: "a bare highlight carries its numeric book_id",
    input: { id: 7, text: "quoted text", book_id: 9001 },
    expected: {
      type: "highlight",
      externalId: "7",
      title: "quoted text",
      bodyPreview: "quoted text",
      url: null,
      canonicalUrl: null,
      modifiedAt: NOW,
      metadata: {
        highlight_id: "7",
        text: "quoted text",
        note: null,
        book_id: 9001,
        location: null,
        location_type: null,
        color: null,
        tags: [],
        source_url: null,
        highlighted_at: null,
        updated_at: null,
        canonical_url: null,
      },
    },
  },
];

// ─── Books ───────────────────────────────────────────────────────────────────

const LAST_HIGHLIGHT_ISO = "2024-03-01T12:00:00.000Z";
const LAST_HIGHLIGHT_MS = 1_709_294_400_000;
const BOOK_TITLE = "Release It! Design and Deploy Production-Ready Software";
const AUTHOR = "Michael T. Nygard";
const DOC_NOTE = "The stability-patterns chapters are the ones worth re-reading";
const REVIEW = "https://readwise.io/bookreview/9001";

function makeBook(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 9001,
    title: BOOK_TITLE,
    author: AUTHOR,
    category: "books",
    source: "kindle",
    num_highlights: 42,
    last_highlight_at: LAST_HIGHLIGHT_ISO,
    updated: UPDATED_ISO,
    cover_image_url: "https://example.com/cover.png",
    highlights_url: REVIEW,
    source_url: ARTICLE,
    asin: "B00A32NXZO",
    tags: [
      { id: 1, name: "reliability" },
      { id: 2, name: "retries" },
    ],
    document_note: DOC_NOTE,
    resurface_weighting: 1.5,
    source_syncs_all_books_together: false,
    ...over,
  };
}

const BOOK_META: Record<string, unknown> = {
  book_id: 9001,
  title: BOOK_TITLE,
  author: AUTHOR,
  category: "books",
  source: "kindle",
  num_highlights: 42,
  asin: "B00A32NXZO",
  tags: ["reliability", "retries"],
  document_note: DOC_NOTE,
  source_url: ARTICLE,
  highlights_url: REVIEW,
  last_highlight_at: LAST_HIGHLIGHT_MS,
  updated_at: UPDATED_MS,
  canonical_url: ARTICLE,
};

const BOOK_ROW: ExpectedRow = {
  type: "book",
  externalId: "book/9001",
  title: BOOK_TITLE,
  bodyPreview: DOC_NOTE,
  url: ARTICLE,
  canonicalUrl: ARTICLE,
  modifiedAt: UPDATED_MS,
  metadata: BOOK_META,
};

function bookRow(over: Partial<ExpectedRow>, meta: Record<string, unknown> = {}): ExpectedRow {
  return { ...BOOK_ROW, ...over, metadata: { ...BOOK_META, ...meta } };
}

const BOOK_CASES: readonly ParityCase[] = [
  { name: "null is skipped", input: null, expected: null },
  { name: "a string is skipped", input: "nope", expected: null },
  { name: "a number is skipped", input: 42, expected: null },
  { name: "an array is skipped", input: [makeBook()], expected: null },
  { name: "a missing id is skipped", input: without(makeBook(), "id"), expected: null },
  { name: "a string id is skipped", input: makeBook({ id: "9001" }), expected: null },
  { name: "a NaN id is skipped", input: makeBook({ id: Number.NaN }), expected: null },
  { name: "the full book", input: makeBook(), expected: BOOK_ROW },
  {
    name: "the title is trimmed",
    input: makeBook({ title: "  Release It!  " }),
    expected: bookRow({ title: "Release It!" }, { title: "Release It!" }),
  },
  {
    name: "no title: the title falls back to the author",
    input: without(makeBook(), "title"),
    expected: bookRow({ title: AUTHOR }, { title: null }),
  },
  {
    name: "blank title and author: `Book <id>`",
    input: makeBook({ title: "   ", author: "" }),
    expected: bookRow({ title: "Book 9001" }, { title: null, author: null }),
  },
  {
    name: "no document note: the preview is the author",
    input: without(makeBook(), "document_note"),
    expected: bookRow({ bodyPreview: AUTHOR }, { document_note: null }),
  },
  {
    name: "no note or author: the preview is the category",
    input: makeBook({ document_note: "", author: "" }),
    expected: bookRow({ bodyPreview: "books" }, { document_note: null, author: null }),
  },
  {
    name: "no note, author or category: the preview is the title",
    input: makeBook({ document_note: "", author: "", category: "" }),
    expected: bookRow(
      { bodyPreview: BOOK_TITLE },
      { document_note: null, author: null, category: null },
    ),
  },
  {
    name: "no updated: modifiedAt is last_highlight_at",
    input: without(makeBook(), "updated"),
    expected: bookRow({ modifiedAt: LAST_HIGHLIGHT_MS }, { updated_at: null }),
  },
  {
    name: "no timestamps: modifiedAt is the walk's now",
    input: without(makeBook(), "updated", "last_highlight_at"),
    expected: bookRow({ modifiedAt: NOW }, { updated_at: null, last_highlight_at: null }),
  },
  {
    name: "a null source url: the Readwise book-review url (Kindle)",
    input: makeBook({ source_url: null }),
    expected: bookRow(
      { url: REVIEW, canonicalUrl: REVIEW },
      { source_url: null, canonical_url: REVIEW },
    ),
  },
  {
    name: "empty source and review urls: no url",
    input: makeBook({ source_url: "", highlights_url: "" }),
    expected: bookRow(NO_URL, { source_url: null, highlights_url: null, canonical_url: null }),
  },
  {
    name: "missing source and review urls: no url",
    input: without(makeBook(), "source_url", "highlights_url"),
    expected: bookRow(NO_URL, { source_url: null, highlights_url: null, canonical_url: null }),
  },
  {
    name: "missing optional fields pass through as null; tags as []",
    input: without(
      makeBook(),
      "author",
      "category",
      "source",
      "num_highlights",
      "asin",
      "document_note",
      "tags",
    ),
    expected: bookRow(
      { bodyPreview: BOOK_TITLE },
      {
        author: null,
        category: null,
        source: null,
        num_highlights: null,
        asin: null,
        document_note: null,
        tags: [],
      },
    ),
  },
];

describe("readwise mapping parity with the gateway", () => {
  test("the fixture timestamps are the epoch-ms the gateway stored", () => {
    expect(Date.parse(HIGHLIGHTED_ISO)).toBe(HIGHLIGHTED_MS);
    expect(Date.parse(UPDATED_ISO)).toBe(UPDATED_MS);
    expect(Date.parse(LAST_HIGHLIGHT_ISO)).toBe(LAST_HIGHLIGHT_MS);
  });

  describe("highlight", () => {
    for (const c of HIGHLIGHT_CASES) {
      test(c.name, () => {
        assertParity(mapReadwiseHighlightToItem(c.input, CTX), c.expected);
      });
    }
  });

  describe("book", () => {
    for (const c of BOOK_CASES) {
      test(c.name, () => {
        assertParity(mapReadwiseBookToItem(c.input, CTX), c.expected);
      });
    }
  });

  test("a book and a highlight sharing a numeric id get distinct externalIds", () => {
    const book = mapReadwiseBookToItem(makeBook({ id: 9001 }), CTX);
    const highlight = mapReadwiseHighlightToItem({ id: 9001, text: "t" }, CTX);
    expect(book?.externalId).toBe("book/9001");
    expect(highlight?.externalId).toBe("9001");
  });

  test("every case list is non-empty and has a mapped row", () => {
    for (const cases of [HIGHLIGHT_CASES, BOOK_CASES]) {
      expect(cases.filter((c) => c.expected !== null).length).toBeGreaterThan(5);
    }
  });
});
