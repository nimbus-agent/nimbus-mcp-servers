/**
 * A Readwise book (`GET /api/v2/books/`) as a sync item. Ported from the gateway's
 * `readwise-book-mapping.ts` (Nimbus origin/main 61e034a5) with every field rule unchanged;
 * `test/mapping-parity.test.ts` pins each field to what the gateway stored.
 *
 * `externalId` is `book/<numeric id>`, NOT the bare id. Readwise numbers books and highlights in
 * separate sequences, so book 9001 and highlight 9001 both exist, and the gateway's item key is
 * `<service>:<externalId>`: a bare id would let one type's row overwrite the other's.
 */
import {
  asRecord,
  namedTags,
  numberField,
  parseIsoMs,
  type ReadwiseMappingContext,
  type ReadwiseSyncItem,
  stringField,
} from "./record-fields.ts";

/** Keeps `readwise:book/<id>` distinct from the highlight `readwise:<id>`. */
export const READWISE_BOOK_EXTERNAL_ID_PREFIX = "book/";

/** Trimmed string field, or null when absent/blank. */
function trimmedField(row: Record<string, unknown>, key: string): string | null {
  const raw = stringField(row, key);
  if (raw === undefined) {
    return null;
  }
  const trimmed = raw.trim();
  return trimmed === "" ? null : trimmed;
}

function firstNonNull(candidates: readonly (string | null)[], fallback: string): string {
  for (const candidate of candidates) {
    if (candidate !== null) {
      return candidate;
    }
  }
  return fallback;
}

export function mapReadwiseBookToItem(
  raw: unknown,
  ctx: ReadwiseMappingContext,
): ReadwiseSyncItem | null {
  const row = asRecord(raw);
  if (row === undefined) {
    return null;
  }

  const idNum = numberField(row, "id");
  if (idNum === undefined) {
    return null;
  }
  const id = String(idNum);

  const title = trimmedField(row, "title");
  const author = trimmedField(row, "author");
  const category = trimmedField(row, "category");
  const source = trimmedField(row, "source");
  const documentNote = trimmedField(row, "document_note");
  const asin = trimmedField(row, "asin");
  const sourceUrl = trimmedField(row, "source_url");
  const highlightsUrl = trimmedField(row, "highlights_url");
  const numHighlights = numberField(row, "num_highlights") ?? null;
  const tags = namedTags(row["tags"]);

  const lastHighlightAt = parseIsoMs(row["last_highlight_at"]);
  const updatedAt = parseIsoMs(row["updated"]);

  const titleText = firstNonNull([title, author], `Book ${id}`);
  const bodyPreview = firstNonNull([documentNote, author, category], titleText);

  // Kindle/ePub books have no public source URL; the Readwise book-review page
  // is the only stable, user-openable URL for them.
  const canonicalUrl = sourceUrl ?? highlightsUrl;

  const modifiedAt = updatedAt ?? lastHighlightAt ?? ctx.syncedAt;

  const metadata: Record<string, unknown> = {
    // NUMBER, not the stringified id: a highlight stores its parent as
    // `metadata.book_id` (a number), and this is the field that joins them.
    book_id: idNum,
    title,
    author,
    category,
    source,
    num_highlights: numHighlights,
    asin,
    tags,
    document_note: documentNote,
    source_url: sourceUrl,
    highlights_url: highlightsUrl,
    last_highlight_at: lastHighlightAt,
    updated_at: updatedAt,
    canonical_url: canonicalUrl,
  };

  return {
    type: "book",
    externalId: `${READWISE_BOOK_EXTERNAL_ID_PREFIX}${id}`,
    title: titleText,
    bodyPreview,
    url: canonicalUrl,
    canonicalUrl,
    modifiedAt,
    metadata,
  };
}
