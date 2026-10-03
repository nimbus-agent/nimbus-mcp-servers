import {
  asRecord,
  makeQueryFilter,
  nestedString,
  type SearchMatchOptions,
  stringField,
} from "../../../shared/search-filter.ts";

export type DatabricksSearchMatchOptions = SearchMatchOptions;

function numberAt(row: Record<string, unknown>, key: string): string {
  const v = row[key];
  return typeof v === "number" && Number.isFinite(v) ? String(v) : "";
}

function fieldsOf(item: unknown): readonly string[] | null {
  const row = asRecord(item);
  if (row === undefined) {
    return null;
  }
  return [
    nestedString(row, ["settings", "name"]),
    stringField(row, "creator_user_name"),
    numberAt(row, "job_id"),
  ];
}

export const filterDatabricksJobs = makeQueryFilter(fieldsOf);
