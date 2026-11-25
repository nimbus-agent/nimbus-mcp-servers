import {
  fieldsFromPaths,
  makeQueryFilter,
  type SearchMatchOptions,
} from "../../../shared/search-filter.ts";

export type LeverSearchMatchOptions = SearchMatchOptions;

export const filterLeverPostings = makeQueryFilter(
  fieldsFromPaths(
    [
      "text",
      "state",
      ["categories", "team"],
      ["categories", "department"],
      ["categories", "location"],
    ],
    { tags: true },
  ),
);
