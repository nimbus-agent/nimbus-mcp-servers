import {
  makeQueryFilter,
  recordFieldsFromKeys,
  type SearchMatchOptions,
} from "../../../shared/search-filter.ts";

export type BigeyeSearchMatchOptions = SearchMatchOptions;

export const filterBigeyeIssues = makeQueryFilter(
  recordFieldsFromKeys(["summary", "title", "description"]),
);
