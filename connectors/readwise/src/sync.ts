/**
 * The Readwise sync walk, served one page per `__nimbus_sync` call.
 *
 * Ported from the gateway's `readwise-sync.ts` + `runSinglePassPaginatedSync` (Nimbus origin/main
 * 61e034a5), which walked two streams in one run: highlights (`/api/v2/highlights/`), then books
 * (`/api/v2/books/`), each at most {@link READWISE_SYNC_MAX_PAGES} DRF pages of 1000. The gateway
 * now drives the paging, so the position between calls lives in an extension-owned cursor:
 *
 * - `null`, the resting cursor, or ANY value this module did not mint → highlights page 1.
 * - mid-walk: `nimbus-readwise1:` + base64url(`{"stream":"highlights"|"books","page":N}`), the
 *   encoding the gateway's `encodeNimbusJsonCursor` used for the resting cursor.
 * - after the last books page: {@link READWISE_RESTING_CURSOR}, byte-identical to the gateway's
 *   `pass1Cursor()`, with `hasMore: false`.
 *
 * A stream ends when its page is empty, its `next` is null/empty, or its 20th page was read; the
 * highlights stream's end hands off to books page 1 in the same response that carries the page's
 * items. An HTTP error other than 429/401/403, or a body that is not JSON, ends the CURRENT stream
 * with no items — exactly where today's walk degraded a first-page error to an empty result and
 * broke out on a later-page one. A rejected fetch propagates (today's `sync()` threw).
 *
 * The token is only ever an `Authorization` header value: no response, log or error carries it.
 */
import type { SyncResponse } from "@nimbus-dev/sdk/sync";
import { mapReadwiseBookToItem } from "./book-mapping.ts";
import { mapReadwiseHighlightToItem } from "./highlight-mapping.ts";
import { READWISE_BASE } from "./readwise-base.ts";
import { asRecord, type ReadwiseMappingContext, type ReadwiseSyncItem } from "./record-fields.ts";

const CURSOR_PREFIX = "nimbus-readwise1:";
const PAGE_SIZE = 1000;

/** Per-stream page cap, as today. */
export const READWISE_SYNC_MAX_PAGES = 20;

export type ReadwiseStream = "highlights" | "books";

export interface ReadwiseCursorPosition {
  readonly stream: ReadwiseStream;
  readonly page: number;
}

const STREAMS: Readonly<
  Record<
    ReadwiseStream,
    {
      readonly path: string;
      readonly map: (raw: unknown, ctx: ReadwiseMappingContext) => ReadwiseSyncItem | null;
    }
  >
> = {
  highlights: { path: "/api/v2/highlights/", map: mapReadwiseHighlightToItem },
  books: { path: "/api/v2/books/", map: mapReadwiseBookToItem },
};

function encodePayload(payload: unknown): string {
  return CURSOR_PREFIX + Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

/** The cursor a finished pass rests on: the gateway's `pass1Cursor()`, byte for byte. */
export const READWISE_RESTING_CURSOR = encodePayload({ pass: 1 });

export function encodeReadwiseCursor(position: ReadwiseCursorPosition): string {
  return encodePayload({ stream: position.stream, page: position.page });
}

function isStream(v: unknown): v is ReadwiseStream {
  return v === "highlights" || v === "books";
}

/**
 * The position a cursor this module minted points at, or `null` for anything else — which the
 * walk reads as "start a full pass". Strict: exactly the two keys, a known stream, a page within
 * the cap, and the canonical encoding (so no two spellings name one position).
 */
export function decodeReadwiseCursor(raw: string | null): ReadwiseCursorPosition | null {
  if (raw === null || !raw.startsWith(CURSOR_PREFIX)) {
    return null;
  }
  let payload: unknown;
  try {
    payload = JSON.parse(
      Buffer.from(raw.slice(CURSOR_PREFIX.length), "base64url").toString("utf8"),
    ) as unknown;
  } catch {
    return null;
  }
  const o = asRecord(payload);
  if (o === undefined || Object.keys(o).length !== 2) {
    return null;
  }
  const { stream, page } = o;
  if (
    !isStream(stream) ||
    typeof page !== "number" ||
    !Number.isSafeInteger(page) ||
    page < 1 ||
    page > READWISE_SYNC_MAX_PAGES
  ) {
    return null;
  }
  const position: ReadwiseCursorPosition = { stream, page };
  return encodeReadwiseCursor(position) === raw ? position : null;
}

/** The fetch the walk uses; a seam so tests serve Readwise without a network. */
export type ReadwiseFetch = (url: string, init: RequestInit) => Promise<Response>;

export interface ReadwiseSyncDeps {
  /** `READWISE_TOKEN` as the process received it; blank or absent → `unauthenticated`. */
  readonly token: string | undefined;
  /** Defaults to the global `fetch`. */
  readonly fetch?: ReadwiseFetch;
  /** Defaults to `Date.now`. The mappers' `modifiedAt` fallback and the Retry-After clock. */
  readonly now?: () => number;
}

type PageOutcome =
  | { readonly kind: "ok"; readonly parsed: unknown }
  | { readonly kind: "http_error"; readonly status: number; readonly retryAfter: string | null }
  | { readonly kind: "parse_error" };

/** A failure's message with every occurrence of the token cut out. */
function redactedError(e: unknown, token: string): Error {
  const message = e instanceof Error ? e.message : String(e);
  return new Error(`Readwise request failed: ${message.split(token).join("[redacted]")}`);
}

async function getPage(url: string, token: string, fetchFn: ReadwiseFetch): Promise<PageOutcome> {
  let text: string;
  let res: Response;
  try {
    res = await fetchFn(url, {
      headers: { Authorization: `Token ${token}`, Accept: "application/json" },
    });
    text = await res.text();
  } catch (e) {
    throw redactedError(e, token);
  }
  if (!res.ok) {
    return { kind: "http_error", status: res.status, retryAfter: res.headers.get("retry-after") };
  }
  try {
    return { kind: "ok", parsed: JSON.parse(text) as unknown };
  } catch {
    return { kind: "parse_error" };
  }
}

/** The DRF page envelope both list endpoints use; anything else reads as an empty, final page. */
function parseReadwisePage(parsed: unknown): { items: unknown[]; hasMore: boolean } {
  const root = asRecord(parsed);
  if (root === undefined) {
    return { items: [], hasMore: false };
  }
  const results = root["results"];
  const items = Array.isArray(results) ? results : [];
  const nextRaw = root["next"];
  const next = typeof nextRaw === "string" && nextRaw !== "" ? nextRaw : null;
  return { items, hasMore: items.length > 0 && next !== null };
}

/**
 * `Retry-After` as a non-negative integer of ms: delta-seconds, or an HTTP-date (IMF-fixdate or
 * RFC 850, both in GMT) as the time until then, clamped at 0. Anything else — absent, negative,
 * fractional, too large, the obsolete zone-less asctime form — is `undefined`, and the field is
 * left out so the gateway applies its own default.
 */
export function parseRetryAfterMs(header: string | null, now: number): number | undefined {
  if (header === null) {
    return undefined;
  }
  const v = header.trim();
  if (/^\d+$/.test(v)) {
    const ms = Number(v) * 1000;
    return Number.isSafeInteger(ms) ? ms : undefined;
  }
  if (!/^[A-Za-z]{3,9}, .+ GMT$/.test(v)) {
    return undefined;
  }
  const at = Date.parse(v);
  if (!Number.isSafeInteger(at)) {
    return undefined;
  }
  return Math.max(0, at - now);
}

function pageUrl(position: ReadwiseCursorPosition): string {
  const params = new URLSearchParams({ page_size: String(PAGE_SIZE), page: String(position.page) });
  return `${READWISE_BASE}${STREAMS[position.stream].path}?${params.toString()}`;
}

/** The mapped rows of one page; a repeated externalId keeps its LAST row, as today's upserts did. */
function mapPage(
  rows: readonly unknown[],
  stream: ReadwiseStream,
  ctx: ReadwiseMappingContext,
): ReadwiseSyncItem[] {
  const byId = new Map<string, ReadwiseSyncItem>();
  for (const raw of rows) {
    const item = STREAMS[stream].map(raw, ctx);
    if (item !== null) {
      byId.set(item.externalId, item);
    }
  }
  return [...byId.values()];
}

/** The response that ends `stream`: highlights hand off to books page 1; books end the pass. */
function endOfStream(stream: ReadwiseStream, items: ReadwiseSyncItem[]): SyncResponse {
  return stream === "highlights"
    ? {
        status: "ok",
        items,
        cursor: encodeReadwiseCursor({ stream: "books", page: 1 }),
        hasMore: true,
      }
    : { status: "ok", items, cursor: READWISE_RESTING_CURSOR, hasMore: false };
}

/** One `__nimbus_sync` call: fetch the page `cursor` points at and answer with its items. */
export async function readwiseSyncPage(
  cursor: string | null,
  deps: ReadwiseSyncDeps,
): Promise<SyncResponse> {
  const token = deps.token?.trim() ?? "";
  if (token === "") {
    return { status: "unauthenticated" };
  }
  const position = decodeReadwiseCursor(cursor) ?? { stream: "highlights", page: 1 };
  const now = (deps.now ?? Date.now)();
  const fetchFn: ReadwiseFetch = deps.fetch ?? ((url, init) => fetch(url, init));

  const outcome = await getPage(pageUrl(position), token, fetchFn);
  if (outcome.kind === "http_error") {
    if (outcome.status === 429) {
      const retryAfterMs = parseRetryAfterMs(outcome.retryAfter, now);
      return retryAfterMs === undefined
        ? { status: "rate_limited" }
        : { status: "rate_limited", retryAfterMs };
    }
    if (outcome.status === 401 || outcome.status === 403) {
      return { status: "unauthenticated" };
    }
    return endOfStream(position.stream, []);
  }
  if (outcome.kind === "parse_error") {
    return endOfStream(position.stream, []);
  }

  const page = parseReadwisePage(outcome.parsed);
  const items = mapPage(page.items, position.stream, { syncedAt: now });
  if (page.hasMore && position.page < READWISE_SYNC_MAX_PAGES) {
    return {
      status: "ok",
      items,
      cursor: encodeReadwiseCursor({ stream: position.stream, page: position.page + 1 }),
      hasMore: true,
    };
  }
  return endOfStream(position.stream, items);
}
