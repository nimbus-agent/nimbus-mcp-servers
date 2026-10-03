import {
  makeQueryFilter,
  recordFieldsFromKeys,
  type SearchMatchOptions,
} from "../../../shared/search-filter.ts";

export type LookerSearchMatchOptions = SearchMatchOptions;

export const filterLookerDashboards = makeQueryFilter(recordFieldsFromKeys(["title", "id"]));
