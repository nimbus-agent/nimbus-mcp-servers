/**
 * cursor-list-tool — the input contract of a paginated `<prefix>_list` tool.
 *
 * Six connectors (bigeye, looker, monte-carlo, powerbi, snowflake, tableau) page through a
 * collection the same way: the caller passes back an opaque `cursor` — the previous page's
 * `nextCursor`, or nothing / `null` for the first page — plus a `limit`, and receives
 * `{ items, nextCursor }`. Each declared that input schema separately. What the cursor encodes (an
 * offset, a page number, a relay token) and the default page size stay each connector's own.
 */

import { z } from "zod";
import type { ZodObjectSchema } from "./mcp-tool-kit.ts";

/** What a paginated `_list` tool is called with. */
export interface CursorListOptions {
  readonly cursor?: string | null | undefined;
  readonly limit?: number | undefined;
}

/**
 * The paginated `_list` input schema: an optional, nullable opaque `cursor` and an optional
 * integer `limit` from 1 to `maxLimit`.
 */
export function cursorListInputSchema(maxLimit = 500): ZodObjectSchema<CursorListOptions> {
  return z.object({
    cursor: z.string().nullable().optional(),
    limit: z.number().int().min(1).max(maxLimit).optional(),
  });
}
