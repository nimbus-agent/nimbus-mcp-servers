import {
  makeQueryFilter,
  recordFieldsFromKeys,
  type SearchMatchOptions,
} from "../../../shared/search-filter.ts";

export type SupersetSearchMatchOptions = SearchMatchOptions;

export const filterSupersetDashboards = makeQueryFilter(
  recordFieldsFromKeys(["dashboard_title", "slug"]),
);
