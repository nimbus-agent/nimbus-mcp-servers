import {
  makeQueryFilter,
  recordFieldsFromKeys,
  type SearchMatchOptions,
} from "../../../shared/search-filter.ts";

export type TableauSearchMatchOptions = SearchMatchOptions;

export const filterTableauViews = makeQueryFilter(recordFieldsFromKeys(["name", "luid"]));
