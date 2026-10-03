import {
  fieldsFromKeys,
  makeQueryFilter,
  type SearchMatchOptions,
} from "../../../shared/search-filter.ts";

export type FigmaSearchMatchOptions = SearchMatchOptions;

/**
 * Figma file objects are flat — `{ key, name, thumbnail_url, last_modified }`.
 * When flattened by the connector for search, each file additionally carries
 * a `project_name` label. Match against the file name and the project name
 * (case-insensitive substring).
 */
export const filterFigmaFiles = makeQueryFilter(fieldsFromKeys(["name", "project_name"]));
