import {
  asObjectish,
  makeQueryFilter,
  nestedString,
  objectNamesText,
  type SearchMatchOptions,
  stringField,
} from "../../../shared/search-filter.ts";

export type WizSearchMatchOptions = SearchMatchOptions;

function fieldsOf(item: unknown): readonly string[] | null {
  const row = asObjectish(item);
  if (row === undefined) {
    return null;
  }
  return [
    nestedString(row, ["sourceRule", "name"]),
    stringField(row, "description"),
    nestedString(row, ["entity", "name"]),
    nestedString(row, ["entity", "type"]),
    objectNamesText(row, "projects"),
  ];
}

export const filterWizIssues = makeQueryFilter(fieldsOf);
