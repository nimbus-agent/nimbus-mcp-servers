/**
 * collection-tool-kit — the `<prefix>_list` / `<prefix>_get` / `<prefix>_search`
 * triple that most read-only REST connectors expose over a single collection.
 *
 * Sonar reports the tail of this shape as duplicated across readwise, mercury,
 * zoom, lever and intercom, but the flagged blocks understate it: the triple is
 * written out by hand in roughly thirty connectors and is the same three tool
 * bodies every time —
 *
 *   list   → `jsonResult(await get(PATH))`
 *   get    → `jsonResult(await get(ITEM_PATH(encodeURIComponent(id))))`
 *   search → `matchesResult(rows(await get(PATH)), filter, args)`
 *
 * — with only the paths, the envelope key and the descriptions differing. Those
 * are the inputs here.
 *
 * What is NOT hidden: the descriptions. Each connector still writes its own,
 * because they document that API's envelope shape and pagination and are the
 * only thing the model sees when choosing a tool. A generated description would
 * be a real regression in tool quality to save a line.
 *
 * Connectors whose tools do anything else — extra query parameters, a second
 * request, a non-standard error, a POST — keep registering those directly on
 * `reg`. This kit is for the plain triple, not a framework to force the rest
 * into.
 */

import { z } from "zod";
import { matchesResult, type SearchFilter, searchToolInputSchema } from "./mcp-search-tool.ts";
import { mcpJsonResult } from "./mcp-tool-kit.ts";
import type { ZodToolRegistrar } from "./run-read-only-mcp-connector.ts";

/** The per-connector search cap every connector in this family uses. */
export const DEFAULT_SEARCH_MAX = 100;

/** A `(path) => Promise<unknown>` client, e.g. from `createJsonGetter`. */
export type JsonGetter = (path: string) => Promise<unknown>;

/**
 * Read the row array out of a list response.
 *
 * Most APIs wrap the rows in a named key (`{ results }`, `{ data }`,
 * `{ accounts }`, `{ conversations }`); a few return a bare array, which is
 * {@link identityRows}.
 */
export type RowsAccessor = (root: unknown) => unknown;

/** Rows under a single envelope key, e.g. `envelopeRows("results")`. */
export function envelopeRows(key: string): RowsAccessor {
  return (root: unknown): unknown => (root as Record<string, unknown> | null)?.[key];
}

/** The response IS the row array. */
export const identityRows: RowsAccessor = (root: unknown): unknown => root;

export interface CollectionListSpec {
  /** Path appended to the getter's base. */
  readonly path: string;
  readonly description: string;
  /** Tool name suffix. Defaults to `"list"`, giving `<prefix>_list`. */
  readonly tool?: string;
}

export interface CollectionItemSpec {
  /** Builds the path for one id. The id arrives already percent-encoded. */
  readonly path: (encodedId: string) => string;
  readonly description: string;
  /** Tool name suffix. Defaults to `"get"`. */
  readonly tool?: string;
}

export interface CollectionSearchSpec {
  /** Path to search over. Defaults to the list path. */
  readonly path?: string;
  readonly description: string;
  readonly rows: RowsAccessor;
  readonly filter: SearchFilter;
  /** Per-connector `limit` cap. Defaults to {@link DEFAULT_SEARCH_MAX}. */
  readonly maxLimit?: number;
  /** Tool name suffix. Defaults to `"search"`. */
  readonly tool?: string;
}

export interface CollectionToolsConfig {
  /** Tool-name prefix, e.g. `"mercury"` for `mercury_list`. */
  readonly prefix: string;
  readonly get: JsonGetter;
  readonly list: CollectionListSpec;
  readonly item?: CollectionItemSpec;
  readonly search?: CollectionSearchSpec;
}

/** The names {@link registerCollectionTools} would register for `config`. */
export function collectionToolNames(config: CollectionToolsConfig): string[] {
  const names = [`${config.prefix}_${config.list.tool ?? "list"}`];
  if (config.item !== undefined) {
    names.push(`${config.prefix}_${config.item.tool ?? "get"}`);
  }
  if (config.search !== undefined) {
    names.push(`${config.prefix}_${config.search.tool ?? "search"}`);
  }
  return names;
}

/**
 * Register the list/get/search triple described by `config`.
 *
 * `item` and `search` are optional: a few collections are list-only, and a few
 * have no id to fetch by.
 */
export function registerCollectionTools(
  reg: ZodToolRegistrar,
  config: CollectionToolsConfig,
): void {
  const { prefix, get, list, item, search } = config;

  reg(`${prefix}_${list.tool ?? "list"}`, list.description, z.object({}), async () => {
    return mcpJsonResult(await get(list.path));
  });

  if (item !== undefined) {
    reg(
      `${prefix}_${item.tool ?? "get"}`,
      item.description,
      z.object({ id: z.string().min(1) }),
      async (p) => {
        return mcpJsonResult(await get(item.path(encodeURIComponent(p.id))));
      },
    );
  }

  if (search !== undefined) {
    reg(
      `${prefix}_${search.tool ?? "search"}`,
      search.description,
      searchToolInputSchema(search.maxLimit ?? DEFAULT_SEARCH_MAX),
      async (p) => {
        const root = await get(search.path ?? list.path);
        return matchesResult(search.rows(root), search.filter, p);
      },
    );
  }
}
