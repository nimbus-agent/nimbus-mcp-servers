import {
  fieldsFromPaths,
  makeQueryFilter,
  type SearchMatchOptions,
} from "../../../shared/search-filter.ts";

export type NetlifySearchMatchOptions = SearchMatchOptions;

export const filterNetlifySites = makeQueryFilter(
  fieldsFromPaths([
    "id",
    "name",
    "url",
    "ssl_url",
    ["build_settings", "repo_url"],
    ["build_settings", "repo_branch"],
    ["published_deploy", "state"],
    ["published_deploy", "branch"],
    ["published_deploy", "commit_ref"],
  ]),
);
