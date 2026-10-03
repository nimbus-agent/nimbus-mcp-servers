import {
  asObjectish,
  makeQueryFilter,
  nestedString,
  type SearchMatchOptions,
  stringField,
} from "../../../shared/search-filter.ts";

export type NetlifySearchMatchOptions = SearchMatchOptions;

function fieldsOf(item: unknown): readonly string[] | null {
  const row = asObjectish(item);
  if (row === undefined) {
    return null;
  }
  return [
    stringField(row, "id"),
    stringField(row, "name"),
    stringField(row, "url"),
    stringField(row, "ssl_url"),
    nestedString(row, ["build_settings", "repo_url"]),
    nestedString(row, ["build_settings", "repo_branch"]),
    nestedString(row, ["published_deploy", "state"]),
    nestedString(row, ["published_deploy", "branch"]),
    nestedString(row, ["published_deploy", "commit_ref"]),
  ];
}

export const filterNetlifySites = makeQueryFilter(fieldsOf);
