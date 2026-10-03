import {
  asObjectish,
  makeQueryFilter,
  nonEmptyStringsText,
  type SearchMatchOptions,
  stringField,
} from "../../../shared/search-filter.ts";

export type PrefectSearchMatchOptions = SearchMatchOptions;

function fieldsOf(item: unknown): readonly string[] | null {
  const row = asObjectish(item);
  if (row === undefined) {
    return null;
  }
  return [
    stringField(row, "name"),
    stringField(row, "description"),
    stringField(row, "work_pool_name"),
    stringField(row, "work_queue_name"),
    stringField(row, "status"),
    // Prefect deployment tags are a bare string array (not `{name}` objects).
    nonEmptyStringsText(row, "tags"),
  ];
}

export const filterPrefectDeployments = makeQueryFilter(fieldsOf);
