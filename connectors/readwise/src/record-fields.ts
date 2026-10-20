/*
 * Field readers for the two Readwise mappers, ported unchanged from the gateway's
 * `unknown-record.ts` and `_lib/field-helpers.ts` (Nimbus origin/main 61e034a5). Each rule is
 * load-bearing for parity with rows the gateway already indexed, so none of them is "simplified":
 * `shared/search-filter.ts` has an `asRecord` of the same rule but a `stringField` that returns ""
 * rather than `undefined`, which would change what a missing field maps to.
 */

export function asRecord(v: unknown): Record<string, unknown> | undefined {
  if (v === null || typeof v !== "object" || Array.isArray(v)) {
    return undefined;
  }
  return v as Record<string, unknown>;
}

export function stringField(r: Record<string, unknown>, key: string): string | undefined {
  const v = r[key];
  return typeof v === "string" ? v : undefined;
}

export function numberField(r: Record<string, unknown>, key: string): number | undefined {
  const v = r[key];
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/**
 * The non-empty `name` values of an array of tag objects (`[{ id, name }]`), in input order. A
 * non-array yields `[]`; an entry that is not a plain object, or whose `name` is absent, not a
 * string, or empty, is skipped.
 */
export function namedTags(raw: unknown): string[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const names: string[] = [];
  for (const t of raw) {
    const row = asRecord(t);
    if (row === undefined) {
      continue;
    }
    const name = stringField(row, "name");
    if (name !== undefined && name !== "") {
      names.push(name);
    }
  }
  return names;
}

/** An ISO-8601 string as epoch ms, or `null` when it is not a string or does not parse. */
export function parseIsoMs(v: unknown): number | null {
  return typeof v === "string" && Number.isFinite(Date.parse(v)) ? Date.parse(v) : null;
}

/**
 * The one item shape both mappers emit: a sync-v1 `SyncItem` with the body as a preview. Exactly
 * these eight fields — `service` and `syncedAt` are the gateway's, never the item's.
 */
export interface ReadwiseSyncItem {
  readonly type: "highlight" | "book";
  readonly externalId: string;
  readonly title: string;
  readonly bodyPreview: string;
  readonly url: string | null;
  readonly canonicalUrl: string | null;
  readonly modifiedAt: number;
  readonly metadata: Record<string, unknown>;
}

export interface ReadwiseMappingContext {
  /** The walk's `now`: only the `modifiedAt` fallback for a row with no usable timestamp. */
  readonly syncedAt: number;
}
