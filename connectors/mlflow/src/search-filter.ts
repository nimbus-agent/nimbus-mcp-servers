import {
  asRecord,
  makeQueryFilter,
  type SearchMatchOptions,
  stringField,
} from "../../../shared/search-filter.ts";

export type MlflowSearchMatchOptions = SearchMatchOptions;

function tagsHaystack(row: Record<string, unknown>): string {
  const tags = row["tags"];
  if (!Array.isArray(tags)) {
    return "";
  }
  const parts: string[] = [];
  for (const t of tags) {
    const tag = asRecord(t);
    if (tag === undefined) {
      continue;
    }
    parts.push(`${stringField(tag, "key")}=${stringField(tag, "value")}`);
  }
  return parts.join(" ");
}

function fieldsOf(item: unknown): readonly string[] | null {
  const row = asRecord(item);
  if (row === undefined) {
    return null;
  }
  return [stringField(row, "name"), stringField(row, "description"), tagsHaystack(row)];
}

export const filterMlflowModels = makeQueryFilter(fieldsOf);
