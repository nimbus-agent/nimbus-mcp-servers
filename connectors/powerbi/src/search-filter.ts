import {
  makeQueryFilter,
  recordFieldsFromKeys,
  type SearchMatchOptions,
} from "../../../shared/search-filter.ts";

export type PowerBiSearchMatchOptions = SearchMatchOptions;

export const filterPowerBiReports = makeQueryFilter(recordFieldsFromKeys(["name", "description"]));
