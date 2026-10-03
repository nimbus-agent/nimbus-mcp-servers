import {
  makeQueryFilter,
  recordFieldsFromKeys,
  type SearchMatchOptions,
} from "../../../shared/search-filter.ts";

export type MetabaseSearchMatchOptions = SearchMatchOptions;

export const filterMetabaseDashboards = makeQueryFilter(
  recordFieldsFromKeys(["name", "description"]),
);
