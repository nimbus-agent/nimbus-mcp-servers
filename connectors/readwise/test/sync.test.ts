/**
 * The `__nimbus_sync` walk: one Readwise page per call, highlights then books, threaded by an
 * extension-owned cursor. No response escapes validation: the only producers are `respond()` and the
 * tool tests, and both pass every response through `check()`, which asserts it passes the SDK's
 * `validateSyncResponse` and the gateway parser's extra rules, fits the size budget, and never
 * carries the token. (A per-test helper, not a global count, so a filtered run still passes.)
 */
import { afterEach, describe, expect, test } from "bun:test";
import { SYNC_TOOL_NAME, type SyncResponse, validateSyncResponse } from "@nimbus-dev/sdk/sync";
import type { McpListResult, ZodObjectSchema } from "../../../shared/mcp-tool-kit.ts";
import type { ZodToolRegistrar } from "../../../shared/run-read-only-mcp-connector.ts";
import {
  decodeReadwiseCursor,
  encodeReadwiseCursor,
  READWISE_RESTING_CURSOR,
  READWISE_SYNC_MAX_PAGES,
  READWISE_SYNC_RESPONSE_BUDGET_BYTES,
  type ReadwiseFetch,
  readwiseSyncPage,
  syncResponseBytes,
} from "../src/sync.ts";
import { registerReadwiseSyncTool } from "../src/sync-tool.ts";

const TOKEN = "rw-SECRET-token-0123456789";
const BASE = "https://readwise.io";
/** A whole second, so an HTTP-date (second precision) round-trips exactly. */
const NOW = 1_760_000_000_000;
/** The gateway's `RAW_META_MAX_BYTES`. */
const META_MAX_BYTES = 65_536;
const ITEM_TYPES = new Set(["highlight", "book"]);

// ─── Every response is checked here ───────────────────────────────────────────

/** What the gateway's `parseSyncResponse` refuses or drops beyond the SDK's structural check. */
function gatewayProblems(r: SyncResponse): string[] {
  if (r.status !== "ok") {
    return [];
  }
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const item of r.items) {
    const raw = item as Record<string, unknown>;
    if (!ITEM_TYPES.has(item.type)) problems.push(`undeclared type ${item.type}`);
    if ("service" in raw || "syncedAt" in raw) problems.push("service/syncedAt on an item");
    if (raw["body"] !== undefined && raw["bodyPreview"] !== undefined)
      problems.push("body+preview");
    if (Buffer.byteLength(JSON.stringify(item.metadata), "utf8") > META_MAX_BYTES) {
      problems.push(`oversized metadata on ${item.externalId}`);
    }
    if (seen.has(item.externalId)) problems.push(`duplicate externalId ${item.externalId}`);
    seen.add(item.externalId);
  }
  return problems;
}

/**
 * Every response's gate. Over `budget` is allowed only for a ONE-item response: the walk sends a
 * single item even when it alone is over budget, so it always progresses.
 */
function check(
  response: SyncResponse,
  budget: number = READWISE_SYNC_RESPONSE_BUDGET_BYTES,
): SyncResponse {
  const verdict = validateSyncResponse(JSON.parse(JSON.stringify(response)) as unknown);
  if (!verdict.ok) {
    throw new Error(`invalid sync response: ${verdict.reason}`);
  }
  expect(gatewayProblems(response)).toEqual([]);
  expect(JSON.stringify(response)).not.toContain(TOKEN);
  const singleItem = response.status === "ok" && response.items.length === 1;
  if (!singleItem) {
    expect(syncResponseBytes(response)).toBeLessThanOrEqual(budget);
  }
  return response;
}

// ─── A fake Readwise behind an injected fetch ────────────────────────────────

type Stream = "highlights" | "books";

interface FakeRequest {
  readonly url: string;
  readonly stream: Stream;
  readonly page: number;
  readonly headers: Record<string, string>;
}

interface FakeConfig {
  readonly highlights?: unknown[][];
  readonly books?: unknown[][];
  /** Overrides the DRF page for one request; `undefined` falls through to the page tables. */
  readonly override?: (stream: Stream, page: number) => Response | undefined;
  /** `next` is non-null on every page, however many pages exist. */
  readonly endlessNext?: boolean;
}

function fakeReadwise(config: FakeConfig): { fetch: ReadwiseFetch; requests: FakeRequest[] } {
  const requests: FakeRequest[] = [];
  const fetch: ReadwiseFetch = (url, init) => {
    const u = new URL(url);
    const stream: Stream = u.pathname === "/api/v2/books/" ? "books" : "highlights";
    const page = Number(u.searchParams.get("page"));
    requests.push({
      url,
      stream,
      page,
      headers: Object.fromEntries(new Headers(init.headers).entries()),
    });
    const override = config.override?.(stream, page);
    if (override !== undefined) {
      return Promise.resolve(override);
    }
    const pages = (stream === "books" ? config.books : config.highlights) ?? [[]];
    const results = pages[page - 1] ?? [];
    const hasNext = config.endlessNext === true || page < pages.length;
    return Promise.resolve(
      Response.json({
        count: 0,
        next: hasNext ? `${BASE}${u.pathname}?page=${String(page + 1)}` : null,
        previous: null,
        results,
      }),
    );
  };
  return { fetch, requests };
}

async function respond(
  cursor: string | null,
  fake: { fetch: ReadwiseFetch },
  auth: { readonly token: string | undefined } = { token: TOKEN },
  budgetBytes: number = READWISE_SYNC_RESPONSE_BUDGET_BYTES,
): Promise<SyncResponse> {
  return check(
    await readwiseSyncPage(cursor, {
      token: auth.token,
      fetch: fake.fetch,
      now: () => NOW,
      budgetBytes,
    }),
    budgetBytes,
  );
}

function okOf(r: SyncResponse): Extract<SyncResponse, { status: "ok" }> {
  if (r.status !== "ok") {
    throw new Error(`expected status ok, got ${r.status}`);
  }
  return r;
}

function highlight(id: number): Record<string, unknown> {
  return { id, text: `highlight ${String(id)}`, updated: "2024-03-02T08:00:00.000Z" };
}

function book(id: number): Record<string, unknown> {
  return { id, title: `book ${String(id)}`, updated: "2024-03-02T08:00:00.000Z" };
}

const BOOKS_1 = encodeReadwiseCursor({ stream: "books", page: 1 });

// ─── Cursor ───────────────────────────────────────────────────────────────────

describe("cursor", () => {
  test("the resting cursor is byte-identical to the one the gateway persisted", () => {
    // The gateway's pass1Cursor(): encodeNimbusJsonCursor("nimbus-readwise1:", { pass: 1 }),
    // whose payload is base64url JSON.
    expect(READWISE_RESTING_CURSOR).toBe("nimbus-readwise1:eyJwYXNzIjoxfQ");
    expect(READWISE_RESTING_CURSOR).toBe(
      `nimbus-readwise1:${Buffer.from('{"pass":1}', "utf8").toString("base64url")}`,
    );
  });

  test("a position round-trips through the cursor", () => {
    const c = encodeReadwiseCursor({ stream: "books", page: 3 });
    expect(c).toBe(
      `nimbus-readwise1:${Buffer.from('{"stream":"books","page":3}', "utf8").toString("base64url")}`,
    );
    expect(decodeReadwiseCursor(c)).toEqual({ stream: "books", page: 3 });
    expect(decodeReadwiseCursor(encodeReadwiseCursor({ stream: "highlights", page: 20 }))).toEqual({
      stream: "highlights",
      page: 20,
    });
  });

  const enc = (payload: unknown): string =>
    `nimbus-readwise1:${Buffer.from(JSON.stringify(payload), "utf8").toString("base64url")}`;
  const unrecognised: readonly [string, string | null][] = [
    ["null", null],
    ["empty", ""],
    ["garbage", "garbage"],
    ["the legacy resting cursor", READWISE_RESTING_CURSOR],
    ["the legacy cursor spelled as raw JSON", 'nimbus-readwise1:{"pass":1}'],
    ["a bare prefix", "nimbus-readwise1:"],
    ["another connector's prefix", "nimbus-raindrop1:eyJwYWdlIjoyfQ"],
    ["raw JSON position", 'nimbus-readwise1:{"stream":"books","page":3}'],
    ["an unknown stream", enc({ stream: "documents", page: 2 })],
    ["page 0", enc({ stream: "books", page: 0 })],
    ["a negative page", enc({ stream: "books", page: -1 })],
    ["a fractional page", enc({ stream: "books", page: 1.5 })],
    ["a string page", enc({ stream: "books", page: "2" })],
    ["a page past the cap", enc({ stream: "books", page: READWISE_SYNC_MAX_PAGES + 1 })],
    ["an extra key", enc({ stream: "books", page: 2, extra: true })],
    ["an extra key beside skip", enc({ stream: "books", page: 2, skip: 1, extra: true })],
    ["skip 0", enc({ stream: "books", page: 2, skip: 0 })],
    ["a negative skip", enc({ stream: "books", page: 2, skip: -1 })],
    ["a fractional skip", enc({ stream: "books", page: 2, skip: 1.5 })],
    ["a string skip", enc({ stream: "books", page: 2, skip: "1" })],
    ["skip before page", enc({ stream: "books", skip: 1, page: 2 })],
    ["an array payload", enc(["books", 2])],
    [
      "a payload that is not JSON",
      `nimbus-readwise1:${Buffer.from("{nope").toString("base64url")}`,
    ],
    ["non-canonical base64", `${enc({ stream: "books", page: 2 })}==`],
  ];

  for (const [name, cursor] of unrecognised) {
    test(`${name} is unrecognised and starts a full pass at highlights page 1`, async () => {
      expect(decodeReadwiseCursor(cursor)).toBeNull();
      const fake = fakeReadwise({ highlights: [[highlight(1)]] });
      const r = okOf(await respond(cursor, fake));
      expect(fake.requests.map((q) => [q.stream, q.page])).toEqual([["highlights", 1]]);
      expect(r.items.map((i) => i.externalId)).toEqual(["1"]);
    });
  }

  test("a mid-walk cursor is resumed where it points", async () => {
    const fake = fakeReadwise({ books: [[], [], [book(3)], [book(4)]] });
    const r = okOf(await respond(encodeReadwiseCursor({ stream: "books", page: 3 }), fake));
    expect(fake.requests.map((q) => [q.stream, q.page])).toEqual([["books", 3]]);
    expect(r.items.map((i) => i.externalId)).toEqual(["book/3"]);
    expect(r.cursor).toBe(encodeReadwiseCursor({ stream: "books", page: 4 }));
    expect(r.hasMore).toBe(true);
  });
});

// ─── Paging ───────────────────────────────────────────────────────────────────

describe("paging", () => {
  test("one GET per call, today's query shape and headers", async () => {
    const fake = fakeReadwise({ highlights: [[highlight(1)], [highlight(2)]] });
    const r = okOf(await respond(null, fake));
    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0]?.url).toBe(`${BASE}/api/v2/highlights/?page_size=1000&page=1`);
    expect(fake.requests[0]?.headers).toEqual({
      authorization: `Token ${TOKEN}`,
      accept: "application/json",
    });
    expect(r).toEqual({
      status: "ok",
      items: [
        {
          type: "highlight",
          externalId: "1",
          title: "highlight 1",
          bodyPreview: "highlight 1",
          url: null,
          canonicalUrl: null,
          modifiedAt: Date.parse("2024-03-02T08:00:00.000Z"),
          metadata: expect.any(Object),
        },
      ],
      cursor: encodeReadwiseCursor({ stream: "highlights", page: 2 }),
      hasMore: true,
    });
  });

  test("the books GET has the same shape", async () => {
    const fake = fakeReadwise({ books: [[book(1)]] });
    await respond(BOOKS_1, fake);
    expect(fake.requests[0]?.url).toBe(`${BASE}/api/v2/books/?page_size=1000&page=1`);
  });

  test("the last highlights page hands off to books page 1 in the response carrying its items", async () => {
    const fake = fakeReadwise({ highlights: [[highlight(1), highlight(2)]] });
    const r = okOf(await respond(null, fake));
    expect(r.items.map((i) => i.externalId)).toEqual(["1", "2"]);
    expect(r.cursor).toBe(BOOKS_1);
    expect(r.hasMore).toBe(true);
  });

  test("an empty highlights page ends the stream even when `next` is set", async () => {
    const fake = fakeReadwise({ highlights: [[]], endlessNext: true });
    const r = okOf(await respond(null, fake));
    expect(r).toEqual({ status: "ok", items: [], cursor: BOOKS_1, hasMore: true });
  });

  test("an empty-string `next` ends the stream", async () => {
    const fake = fakeReadwise({
      override: () => Response.json({ next: "", results: [highlight(1)] }),
    });
    const r = okOf(await respond(null, fake));
    expect(r.cursor).toBe(BOOKS_1);
  });

  test("highlights page 19 with more continues to page 20", async () => {
    const pages = Array.from({ length: 25 }, (_, i) => [highlight(i + 1)]);
    const fake = fakeReadwise({ highlights: pages });
    const r = okOf(await respond(encodeReadwiseCursor({ stream: "highlights", page: 19 }), fake));
    expect(r.items.map((i) => i.externalId)).toEqual(["19"]);
    expect(r.cursor).toBe(encodeReadwiseCursor({ stream: "highlights", page: 20 }));
    expect(r.hasMore).toBe(true);
  });

  test(`highlights page ${String(READWISE_SYNC_MAX_PAGES)} hands off to books even when more exist`, async () => {
    expect(READWISE_SYNC_MAX_PAGES).toBe(20);
    const pages = Array.from({ length: 25 }, (_, i) => [highlight(i + 1)]);
    const fake = fakeReadwise({ highlights: pages });
    const r = okOf(await respond(encodeReadwiseCursor({ stream: "highlights", page: 20 }), fake));
    expect(fake.requests.map((q) => [q.stream, q.page])).toEqual([["highlights", 20]]);
    expect(r.items.map((i) => i.externalId)).toEqual(["20"]);
    expect(r.cursor).toBe(BOOKS_1);
    expect(r.hasMore).toBe(true);
  });

  test("the last books page returns the resting cursor, byte-identical, and hasMore false", async () => {
    const fake = fakeReadwise({ books: [[book(1)]] });
    const r = okOf(await respond(BOOKS_1, fake));
    expect(r.items.map((i) => i.externalId)).toEqual(["book/1"]);
    expect(r.cursor).toBe("nimbus-readwise1:eyJwYXNzIjoxfQ");
    expect(r.hasMore).toBe(false);
  });

  test(`books page ${String(READWISE_SYNC_MAX_PAGES)} ends the pass even when more exist`, async () => {
    const pages = Array.from({ length: 25 }, (_, i) => [book(i + 1)]);
    const fake = fakeReadwise({ books: pages });
    const r = okOf(await respond(encodeReadwiseCursor({ stream: "books", page: 20 }), fake));
    expect(r.items.map((i) => i.externalId)).toEqual(["book/20"]);
    expect(r.cursor).toBe(READWISE_RESTING_CURSOR);
    expect(r.hasMore).toBe(false);
  });

  test("a whole pass, driven the way the gateway drives it, yields every item of both streams", async () => {
    const fake = fakeReadwise({
      highlights: [[highlight(1), highlight(2)], [highlight(3)]],
      books: [[book(1)], [book(2)], [book(3)]],
    });
    let cursor: string | null = null;
    const ids: string[] = [];
    for (let calls = 0; calls < 40; calls += 1) {
      const r = okOf(await respond(cursor, fake));
      ids.push(...r.items.map((i) => i.externalId));
      cursor = r.cursor;
      if (!r.hasMore) break;
    }
    expect(ids).toEqual(["1", "2", "3", "book/1", "book/2", "book/3"]);
    expect(cursor).toBe(READWISE_RESTING_CURSOR);
    expect(fake.requests.map((q) => `${q.stream}:${String(q.page)}`)).toEqual([
      "highlights:1",
      "highlights:2",
      "books:1",
      "books:2",
      "books:3",
    ]);
  });

  test("the next pass after the resting cursor starts again at highlights page 1", async () => {
    const fake = fakeReadwise({ highlights: [[highlight(1)]] });
    await respond(READWISE_RESTING_CURSOR, fake);
    expect(fake.requests.map((q) => [q.stream, q.page])).toEqual([["highlights", 1]]);
  });

  test("unmappable rows are skipped and a repeated id keeps its last row", async () => {
    const fake = fakeReadwise({
      highlights: [[highlight(1), { text: "no id" }, null, { ...highlight(1), text: "later" }]],
    });
    const r = okOf(await respond(null, fake));
    expect(r.items.map((i) => [i.externalId, i.title])).toEqual([["1", "later"]]);
  });

  test("an item with no timestamps falls back to the call's now", async () => {
    const fake = fakeReadwise({ highlights: [[{ id: 5, text: "t" }]] });
    const r = okOf(await respond(null, fake));
    expect(r.items[0]?.modifiedAt).toBe(NOW);
  });

  test("a body that is not a DRF envelope reads as an empty, final page", async () => {
    for (const body of [[], { count: 0, next: null }, "text", 7]) {
      const fake = fakeReadwise({ override: () => Response.json(body) });
      expect(await respond(null, fake)).toEqual({
        status: "ok",
        items: [],
        cursor: BOOKS_1,
        hasMore: true,
      });
    }
  });
});

// ─── Size budget ──────────────────────────────────────────────────────────────

function longHighlight(id: number, chars: number): Record<string, unknown> {
  const text = `${String(id)} ${"long highlight text ".repeat(Math.ceil(chars / 20))}`.slice(
    0,
    chars,
  );
  return { id, text, note: null, updated: "2024-03-02T08:00:00.000Z" };
}

/**
 * Calls from `start` until the cursor leaves `stream` page `page`, as the gateway would, and
 * returns every response. Each one goes through `check()` with `budget`.
 */
async function drainPage(
  start: string | null,
  fake: { fetch: ReadwiseFetch },
  budget: number,
  stream: "highlights" | "books",
  page: number,
): Promise<Extract<SyncResponse, { status: "ok" }>[]> {
  const out: Extract<SyncResponse, { status: "ok" }>[] = [];
  let cursor = start;
  for (let calls = 0; calls < 200; calls += 1) {
    const r = okOf(await respond(cursor, fake, { token: TOKEN }, budget));
    out.push(r);
    const at = decodeReadwiseCursor(r.cursor);
    if (!r.hasMore || at === null || at.stream !== stream || at.page !== page || !at.skip) {
      return out;
    }
    cursor = r.cursor;
  }
  throw new Error("the page never finished");
}

describe("size budget", () => {
  test("the budget is 3 MiB", () => {
    expect(READWISE_SYNC_RESPONSE_BUDGET_BYTES).toBe(3 * 1024 * 1024);
  });

  test("a skip cursor round-trips, and skip 0 is the plain cursor", () => {
    const c = encodeReadwiseCursor({ stream: "highlights", page: 2, skip: 7 });
    expect(c).toBe(
      `nimbus-readwise1:${Buffer.from('{"stream":"highlights","page":2,"skip":7}', "utf8").toString("base64url")}`,
    );
    expect(decodeReadwiseCursor(c)).toEqual({ stream: "highlights", page: 2, skip: 7 });
    expect(encodeReadwiseCursor({ stream: "books", page: 1, skip: 0 })).toBe(BOOKS_1);
  });

  test("an over-budget last highlights page splits; the pieces concatenate to the unsplit page and the last hands off to books", async () => {
    const rows = Array.from({ length: 12 }, (_, i) => longHighlight(i + 1, 900));
    const unsplit = okOf(await respond(null, fakeReadwise({ highlights: [rows] })));
    expect(unsplit.items).toHaveLength(12);
    const budget = Math.floor(syncResponseBytes(unsplit) / 3);

    const fake = fakeReadwise({ highlights: [rows] });
    const parts = await drainPage(null, fake, budget, "highlights", 1);
    expect(parts.length).toBeGreaterThanOrEqual(3);
    expect(parts.flatMap((p) => p.items)).toEqual(unsplit.items);
    // Every piece but the last resumes the same page after what it returned.
    let returned = 0;
    for (const p of parts.slice(0, -1)) {
      returned += p.items.length;
      expect(p.items.length).toBeGreaterThan(0);
      expect(p.hasMore).toBe(true);
      expect(decodeReadwiseCursor(p.cursor)).toEqual({
        stream: "highlights",
        page: 1,
        skip: returned,
      });
    }
    const last = parts.at(-1);
    expect(last?.cursor).toBe(BOOKS_1);
    expect(last?.hasMore).toBe(true);
    expect(fake.requests.every((q) => q.stream === "highlights" && q.page === 1)).toBe(true);
  });

  test("a split page with a next page continues to it only after its last item", async () => {
    const rows = Array.from({ length: 8 }, (_, i) => longHighlight(i + 1, 900));
    const fake = fakeReadwise({ highlights: [rows, [highlight(100)]] });
    const parts = await drainPage(null, fake, 6000, "highlights", 1);
    expect(parts.length).toBeGreaterThanOrEqual(2);
    expect(parts.flatMap((p) => p.items).map((i) => i.externalId)).toEqual(
      rows.map((r) => String(r["id"])),
    );
    expect(parts.at(-1)?.cursor).toBe(encodeReadwiseCursor({ stream: "highlights", page: 2 }));
  });

  test("a split last books page ends the pass with the resting cursor", async () => {
    const rows = Array.from({ length: 8 }, (_, i) => ({
      ...book(i + 1),
      document_note: "n".repeat(900),
    }));
    const parts = await drainPage(BOOKS_1, fakeReadwise({ books: [rows] }), 6000, "books", 1);
    expect(parts.length).toBeGreaterThanOrEqual(2);
    expect(parts.slice(0, -1).every((p) => p.hasMore)).toBe(true);
    expect(parts.at(-1)?.cursor).toBe(READWISE_RESTING_CURSOR);
    expect(parts.at(-1)?.hasMore).toBe(false);
    expect(parts.flatMap((p) => p.items)).toHaveLength(8);
  });

  test("a skip cursor resumes after that many mapped items of the same page", async () => {
    // Row 2 has no id and maps to nothing: skip counts MAPPED items, so skip 2 drops ids 1 and 3.
    const rows = [highlight(1), { text: "no id" }, highlight(3), highlight(4), highlight(5)];
    const fake = fakeReadwise({ highlights: [rows] });
    const cursor = encodeReadwiseCursor({ stream: "highlights", page: 1, skip: 2 });
    const r = okOf(await respond(cursor, fake));
    expect(fake.requests.map((q) => [q.stream, q.page])).toEqual([["highlights", 1]]);
    expect(r.items.map((i) => i.externalId)).toEqual(["4", "5"]);
    expect(r.cursor).toBe(BOOKS_1);
    expect(r.hasMore).toBe(true);
  });

  test("a skip past the page's end reads as the page's end", async () => {
    const fake = fakeReadwise({ highlights: [[highlight(1)]] });
    const cursor = encodeReadwiseCursor({ stream: "highlights", page: 1, skip: 5 });
    expect(await respond(cursor, fake)).toEqual({
      status: "ok",
      items: [],
      cursor: BOOKS_1,
      hasMore: true,
    });
  });

  test("an item alone over budget still goes out, one per call, so the walk progresses", async () => {
    const rows = [longHighlight(1, 900), longHighlight(2, 900), longHighlight(3, 900)];
    const parts = await drainPage(null, fakeReadwise({ highlights: [rows] }), 100, "highlights", 1);
    expect(parts.map((p) => p.items.map((i) => i.externalId))).toEqual([["1"], ["2"], ["3"]]);
    expect(parts.at(-1)?.cursor).toBe(BOOKS_1);
  });

  test("at the real budget, a page of 1000 long highlights splits under 3 MiB and loses nothing", async () => {
    const rows = Array.from({ length: 1000 }, (_, i) => longHighlight(i + 1, 2000));
    const fake = fakeReadwise({ highlights: [rows] });
    const parts = await drainPage(null, fake, READWISE_SYNC_RESPONSE_BUDGET_BYTES, "highlights", 1);
    expect(parts.length).toBeGreaterThanOrEqual(2);
    for (const p of parts) {
      expect(syncResponseBytes(p)).toBeLessThanOrEqual(READWISE_SYNC_RESPONSE_BUDGET_BYTES);
    }
    const ids = parts.flatMap((p) => p.items.map((i) => i.externalId));
    expect(ids).toEqual(rows.map((r) => String(r["id"])));
  }, 30_000);
});

// ─── Errors ───────────────────────────────────────────────────────────────────

function status(code: number, headers: Record<string, string> = {}): () => Response {
  return () => new Response("upstream says no", { status: code, headers });
}

describe("errors", () => {
  test("429 with delta-seconds Retry-After → rate_limited, retryAfterMs in ms", async () => {
    const r = await respond(null, fakeReadwise({ override: status(429, { "Retry-After": "7" }) }));
    expect(r).toEqual({ status: "rate_limited", retryAfterMs: 7000 });
  });

  test("429 with an HTTP-date Retry-After → ms until then", async () => {
    const at = new Date(NOW + 30_000).toUTCString();
    const r = await respond(null, fakeReadwise({ override: status(429, { "Retry-After": at }) }));
    expect(r).toEqual({ status: "rate_limited", retryAfterMs: 30_000 });
  });

  test("429 with an HTTP-date in the past → 0", async () => {
    const at = new Date(NOW - 30_000).toUTCString();
    const r = await respond(null, fakeReadwise({ override: status(429, { "Retry-After": at }) }));
    expect(r).toEqual({ status: "rate_limited", retryAfterMs: 0 });
  });

  test("429 without Retry-After → rate_limited with no retryAfterMs", async () => {
    const r = await respond(null, fakeReadwise({ override: status(429) }));
    expect(r).toStrictEqual({ status: "rate_limited" });
    expect(Object.keys(r)).toEqual(["status"]);
  });

  for (const bad of ["soon", "-5", "1.5", "", "99999999999999999999"]) {
    test(`429 with an unusable Retry-After ${JSON.stringify(bad)} omits retryAfterMs`, async () => {
      const r = await respond(
        null,
        fakeReadwise({ override: status(429, { "Retry-After": bad }) }),
      );
      expect(r).toStrictEqual({ status: "rate_limited" });
    });
  }

  test("429 during books is rate_limited too", async () => {
    const r = await respond(
      BOOKS_1,
      fakeReadwise({ override: status(429, { "Retry-After": "1" }) }),
    );
    expect(r).toEqual({ status: "rate_limited", retryAfterMs: 1000 });
  });

  for (const code of [401, 403]) {
    for (const cursor of [null, BOOKS_1]) {
      test(`${String(code)} → unauthenticated (${cursor === null ? "highlights" : "books"})`, async () => {
        const r = await respond(cursor, fakeReadwise({ override: status(code) }));
        expect(r).toStrictEqual({ status: "unauthenticated" });
      });
    }
  }

  test("a 500 mid-highlights ends the highlights stream and hands off to books", async () => {
    const fake = fakeReadwise({ override: status(500) });
    const r = await respond(encodeReadwiseCursor({ stream: "highlights", page: 3 }), fake);
    expect(r).toEqual({ status: "ok", items: [], cursor: BOOKS_1, hasMore: true });
  });

  test("a 404 on highlights page 1 hands off to books", async () => {
    const r = await respond(null, fakeReadwise({ override: status(404) }));
    expect(r).toEqual({ status: "ok", items: [], cursor: BOOKS_1, hasMore: true });
  });

  test("a parse error mid-books ends the pass with the resting cursor", async () => {
    const fake = fakeReadwise({ override: () => new Response("{not json", { status: 200 }) });
    const r = await respond(encodeReadwiseCursor({ stream: "books", page: 2 }), fake);
    expect(r).toEqual({
      status: "ok",
      items: [],
      cursor: "nimbus-readwise1:eyJwYXNzIjoxfQ",
      hasMore: false,
    });
  });

  test("a 502 on books ends the pass with the resting cursor", async () => {
    const r = await respond(BOOKS_1, fakeReadwise({ override: status(502) }));
    expect(r).toEqual({ status: "ok", items: [], cursor: READWISE_RESTING_CURSOR, hasMore: false });
  });

  for (const token of [undefined, "", "   ", "\t\n"]) {
    test(`a blank token (${JSON.stringify(token)}) → unauthenticated with no request`, async () => {
      const fake = fakeReadwise({ highlights: [[highlight(1)]] });
      const r = await respond(null, fake, { token });
      expect(r).toStrictEqual({ status: "unauthenticated" });
      expect(fake.requests).toHaveLength(0);
    });
  }

  test("the token is trimmed before it is sent", async () => {
    const fake = fakeReadwise({ highlights: [[highlight(1)]] });
    await respond(null, fake, { token: `  ${TOKEN}  ` });
    expect(fake.requests[0]?.headers["authorization"]).toBe(`Token ${TOKEN}`);
  });

  test("a network failure propagates, and its error never carries the token", async () => {
    const fetch: ReadwiseFetch = (_url, init) =>
      Promise.reject(
        new Error(`connect ECONNREFUSED (sent ${new Headers(init.headers).get("authorization")})`),
      );
    let caught: unknown;
    try {
      await readwiseSyncPage(null, { token: TOKEN, fetch, now: () => NOW });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    const message = caught instanceof Error ? `${caught.message} ${String(caught.stack)}` : "";
    expect(message).toContain("ECONNREFUSED");
    expect(message).not.toContain(TOKEN);
  });

  test("no failing path echoes the token, even when Readwise does", async () => {
    const echo =
      (code: number): (() => Response) =>
      () =>
        new Response(`bad token ${TOKEN}`, { status: code, headers: { "Retry-After": TOKEN } });
    for (const code of [400, 401, 403, 429, 500]) {
      for (const cursor of [null, BOOKS_1]) {
        const r = await respond(cursor, fakeReadwise({ override: echo(code) }));
        expect(JSON.stringify(r)).not.toContain(TOKEN);
      }
    }
    const parse = () => new Response(`{${TOKEN}`, { status: 200 });
    const r = await respond(null, fakeReadwise({ override: parse }));
    expect(JSON.stringify(r)).not.toContain(TOKEN);
  });
});

// ─── The MCP tool ─────────────────────────────────────────────────────────────

interface Captured {
  readonly name: string;
  readonly schema: ZodObjectSchema<unknown>;
  readonly handler: (args: unknown) => Promise<McpListResult>;
}

function captureSyncTool(fetch: ReadwiseFetch): Captured[] {
  const captured: Captured[] = [];
  const reg: ZodToolRegistrar = (name, _description, schema, handler) => {
    captured.push({
      name,
      schema: schema as ZodObjectSchema<unknown>,
      handler: handler as (args: unknown) => Promise<McpListResult>,
    });
  };
  registerReadwiseSyncTool(reg, { fetch });
  return captured;
}

async function callTool(tool: Captured, args: unknown): Promise<McpListResult> {
  const parsed = tool.schema.safeParse(args);
  if (!parsed.success) {
    throw new Error(parsed.error.message);
  }
  return tool.handler(parsed.data);
}

describe("the __nimbus_sync tool", () => {
  const saved = process.env["READWISE_TOKEN"];
  afterEach(() => {
    if (saved === undefined) {
      delete process.env["READWISE_TOKEN"];
    } else {
      process.env["READWISE_TOKEN"] = saved;
    }
  });

  test("registers exactly one tool, named by the SDK's SYNC_TOOL_NAME", () => {
    const tools = captureSyncTool(fakeReadwise({}).fetch);
    expect(tools.map((t) => t.name)).toEqual([SYNC_TOOL_NAME]);
    expect(SYNC_TOOL_NAME).toBe("__nimbus_sync");
  });

  test("answers with ONE text part holding JSON.stringify(response), token read at call time", async () => {
    const fake = fakeReadwise({ highlights: [[highlight(1)]] });
    const [tool] = captureSyncTool(fake.fetch);
    if (tool === undefined) throw new Error("no tool registered");
    process.env["READWISE_TOKEN"] = TOKEN;
    const result = await callTool(tool, { cursor: null, depth: "full", historyFloorMs: 0 });
    expect(result.content).toHaveLength(1);
    const part = result.content[0];
    expect(part?.type).toBe("text");
    const parsed = JSON.parse(part?.text ?? "") as SyncResponse;
    expect(part?.text).toBe(JSON.stringify(parsed));
    const ok = okOf(check(parsed));
    expect(ok.items.map((i) => i.externalId)).toEqual(["1"]);
    expect(fake.requests[0]?.headers["authorization"]).toBe(`Token ${TOKEN}`);
  });

  test("a blank READWISE_TOKEN answers unauthenticated without a request", async () => {
    const fake = fakeReadwise({ highlights: [[highlight(1)]] });
    const [tool] = captureSyncTool(fake.fetch);
    if (tool === undefined) throw new Error("no tool registered");
    process.env["READWISE_TOKEN"] = "  ";
    const result = await callTool(tool, { cursor: "anything", depth: "metadata_only" });
    expect(JSON.parse(result.content[0]?.text ?? "")).toEqual({ status: "unauthenticated" });
    expect(fake.requests).toHaveLength(0);
  });

  test("takes the SDK's SyncRequest and nothing looser", () => {
    const [tool] = captureSyncTool(fakeReadwise({}).fetch);
    if (tool === undefined) throw new Error("no tool registered");
    const ok = (args: unknown): boolean => tool.schema.safeParse(args).success;
    expect(ok({ cursor: null, depth: "full" })).toBe(true);
    expect(ok({ cursor: "c", depth: "summary", historyFloorMs: 1 })).toBe(true);
    expect(ok({ cursor: "c", depth: "metadata_only" })).toBe(true);
    expect(ok({ depth: "full" })).toBe(false);
    expect(ok({ cursor: 3, depth: "full" })).toBe(false);
    expect(ok({ cursor: null })).toBe(false);
    expect(ok({ cursor: null, depth: "everything" })).toBe(false);
    expect(ok({ cursor: null, depth: "full", historyFloorMs: "0" })).toBe(false);
  });
});
