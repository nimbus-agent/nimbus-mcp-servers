import {
  fieldsFromPaths,
  makeQueryFilter,
  type SearchMatchOptions,
} from "../../../shared/search-filter.ts";

export type SemgrepSearchMatchOptions = SearchMatchOptions;

export const filterSemgrepFindings = makeQueryFilter(
  fieldsFromPaths(["rule_name", "rule_message", ["location", "file_path"], ["repository", "name"]]),
);
