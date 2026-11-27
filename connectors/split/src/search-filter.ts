import { asObjectish, makeQueryFilter, stringField } from "../../../shared/search-filter.ts";

/** A split's tags: Split sends `{ name }` objects; a bare string is accepted too. */
function tagsString(row: Record<string, unknown>): string {
  const tags = row["tags"];
  if (!Array.isArray(tags)) {
    return "";
  }
  const names: string[] = [];
  for (const t of tags) {
    if (typeof t === "string") {
      names.push(t);
    } else {
      const name = asObjectish(t)?.["name"];
      if (typeof name === "string") names.push(name);
    }
  }
  return names.join(" ");
}

function fieldsOf(item: unknown): readonly string[] | null {
  const row = asObjectish(item);
  if (row === undefined) {
    return null;
  }
  return [stringField(row, "name"), stringField(row, "description"), tagsString(row)];
}

/** Case-insensitive substring match over a split's name, description and tag names. */
export const filterSplits = makeQueryFilter(fieldsOf);
