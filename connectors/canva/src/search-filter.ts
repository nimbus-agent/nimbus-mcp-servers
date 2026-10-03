import {
  fieldsFromKeys,
  makeQueryFilter,
  type SearchMatchOptions,
} from "../../../shared/search-filter.ts";

export type CanvaSearchMatchOptions = SearchMatchOptions;

/**
 * Canva design objects are flat — `{ id, title, urls: { edit_url, view_url },
 * thumbnail: { url, ... }, ... }`. Designs carry no description or owner field,
 * so match against the design title (case-insensitive substring).
 */
export const filterCanvaDesigns = makeQueryFilter(fieldsFromKeys(["title"]));
