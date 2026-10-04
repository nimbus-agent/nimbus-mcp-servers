import {
  asObjectish,
  makeQueryFilter,
  nonEmptyStringsText,
  type SearchMatchOptions,
  stringField,
  tagNamesFromObjects,
} from "../../../shared/search-filter.ts";

export type AirflowSearchMatchOptions = SearchMatchOptions;

function fieldsOf(item: unknown): readonly string[] | null {
  const row = asObjectish(item);
  if (row === undefined) {
    return null;
  }
  return [
    stringField(row, "dag_id"),
    stringField(row, "description"),
    nonEmptyStringsText(row, "owners"),
    tagNamesFromObjects(row),
  ];
}

export const filterAirflowDags = makeQueryFilter(fieldsOf);
