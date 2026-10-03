import {
  asObjectish,
  makeQueryFilter,
  nestedString,
  type SearchMatchOptions,
  stringField,
} from "../../../shared/search-filter.ts";

export type VercelSearchMatchOptions = SearchMatchOptions;

function fieldsOf(item: unknown): readonly string[] | null {
  const row = asObjectish(item);
  if (row === undefined) {
    return null;
  }
  return [
    stringField(row, "uid"),
    stringField(row, "name"),
    stringField(row, "state"),
    stringField(row, "target"),
    stringField(row, "url"),
    nestedString(row, ["meta", "githubCommitMessage"]),
  ];
}

export const filterVercelDeployments = makeQueryFilter(fieldsOf);
