/**
 * A Readwise highlight (`GET /api/v2/highlights/`) as a sync item. Ported from the gateway's
 * `readwise-highlight-mapping.ts` (Nimbus origin/main 61e034a5) with every field rule unchanged:
 * a migrated user's rows are updated in place only while `type` and `externalId` stay
 * byte-identical, and `test/mapping-parity.test.ts` pins every other field to what the gateway
 * stored. Highlights keep the BARE numeric id as `externalId`.
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

const TITLE_MAX = 80;

export function mapReadwiseHighlightToItem(
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

  const text = stringField(row, "text") ?? null;
  const note = stringField(row, "note") ?? null;
  const location = numberField(row, "location") ?? null;
  const locationType = stringField(row, "location_type") ?? null;
  const color = stringField(row, "color") ?? null;
  const bookId = numberField(row, "book_id") ?? null;
  const sourceUrl = stringField(row, "url") ?? null;
  const tags = namedTags(row["tags"]);

  const highlightedAt = parseIsoMs(row["highlighted_at"]);
  const updatedAt = parseIsoMs(row["updated"]);

  const trimmedText = text === null ? "" : text.trim();
  let title: string;
  if (trimmedText === "") {
    title = `Highlight ${id}`;
  } else if (trimmedText.length > TITLE_MAX) {
    title = `${trimmedText.slice(0, TITLE_MAX)}…`;
  } else {
    title = trimmedText;
  }

  const bodyPreview = note !== null && note !== "" ? note : (text ?? "");

  const canonicalUrl = sourceUrl !== null && sourceUrl !== "" ? sourceUrl : null;

  const modifiedAt = updatedAt ?? highlightedAt ?? ctx.syncedAt;

  const metadata: Record<string, unknown> = {
    highlight_id: id,
    text,
    note,
    book_id: bookId,
    location,
    location_type: locationType,
    color,
    tags,
    source_url: canonicalUrl,
    highlighted_at: highlightedAt,
    updated_at: updatedAt,
    canonical_url: canonicalUrl,
  };

  return {
    type: "highlight",
    externalId: id,
    title,
    bodyPreview,
    url: canonicalUrl,
    canonicalUrl,
    modifiedAt,
    metadata,
  };
}
