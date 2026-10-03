import {
  asObjectish,
  makeQueryFilter,
  nestedString,
  type SearchMatchOptions,
  stringField,
  tagText,
} from "../../../shared/search-filter.ts";

export type LeverSearchMatchOptions = SearchMatchOptions;

function fieldsOf(item: unknown): readonly string[] | null {
  const row = asObjectish(item);
  if (row === undefined) {
    return null;
  }
  return [
    stringField(row, "text"),
    stringField(row, "state"),
    nestedString(row, ["categories", "team"]),
    nestedString(row, ["categories", "department"]),
    nestedString(row, ["categories", "location"]),
    tagText(row),
  ];
}

export const filterLeverPostings = makeQueryFilter(fieldsOf);
