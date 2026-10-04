export interface SearchMatchOptions {
  readonly query: string;
  readonly limit?: number | undefined;
}

export interface FilterByQueryOptions<T> {
  readonly query: string;
  readonly limit?: number | undefined;
  readonly fields: (item: T) => readonly (string | null | undefined)[] | null;
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

export function asObjectish(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object") {
    return undefined;
  }
  return value as Record<string, unknown>;
}

export function stringField(row: Record<string, unknown>, key: string): string {
  const v = row[key];
  return typeof v === "string" ? v : "";
}

export function tagText(row: Record<string, unknown>): string {
  const tags = row["tags"];
  if (!Array.isArray(tags)) {
    return "";
  }
  const names: string[] = [];
  for (const t of tags) {
    if (typeof t === "string") {
      names.push(t);
    }
  }
  return names.join(" ");
}

/**
 * The non-empty string entries of the array at `row[key]`, space-joined; `""` when it is absent or
 * not an array (Airflow `owners`, Prefect `tags`). Unlike {@link tagText}, an empty-string entry is
 * skipped rather than joined — which shows in the haystack's spacing, so it is a separate rule.
 */
export function nonEmptyStringsText(row: Record<string, unknown>, key: string): string {
  const list = row[key];
  if (!Array.isArray(list)) {
    return "";
  }
  return list.filter((v): v is string => typeof v === "string" && v !== "").join(" ");
}

/**
 * The non-empty string `name` of each objectish entry of the array at `row[key]`, space-joined
 * (Wiz `projects`). Returns "" when `row[key]` is absent, not an array, or holds no object entry
 * with a non-empty string `name`.
 */
export function objectNamesText(row: Record<string, unknown>, key: string): string {
  const list = row[key];
  if (!Array.isArray(list)) {
    return "";
  }
  const names: string[] = [];
  for (const entry of list) {
    const obj = asObjectish(entry);
    if (obj === undefined) {
      continue;
    }
    const name = obj["name"];
    if (typeof name === "string" && name !== "") {
      names.push(name);
    }
  }
  return names.join(" ");
}

/**
 * Extract tag names from an array of `{name: string}` tag objects (e.g. Airflow, DependencyTrack).
 * Returns "" when `tags` is absent, not an array, or contains no object entries with a string `name`.
 */
export function tagNamesFromObjects(row: Record<string, unknown>): string {
  return objectNamesText(row, "tags");
}

export function filterByQuery<T>(items: readonly T[], options: FilterByQueryOptions<T>): T[] {
  const needle = options.query.toLowerCase();
  const cap = options.limit ?? 50;
  const out: T[] = [];
  for (const item of items) {
    const parts = options.fields(item);
    if (parts === null) {
      continue;
    }
    const haystack = parts.join(" ").toLowerCase();
    if (!haystack.includes(needle)) {
      continue;
    }
    out.push(item);
    if (out.length >= cap) {
      break;
    }
  }
  return out;
}

export type FieldExtractor = (item: unknown) => readonly (string | null | undefined)[] | null;

/** The one body behind {@link fieldsFromKeys} and {@link recordFieldsFromKeys}. */
function keyedFields(
  toRow: (item: unknown) => Record<string, unknown> | undefined,
  keys: readonly string[],
  tags: boolean,
): FieldExtractor {
  return (item: unknown) => {
    const row = toRow(item);
    if (row === undefined) {
      return null;
    }
    const parts = keys.map((key) => stringField(row, key));
    if (tags) {
      parts.push(tagText(row));
    }
    return parts;
  };
}

/**
 * Build a {@link FieldExtractor} that reads a fixed list of string keys off each
 * objectish row, optionally appending the standard `tags` text. Collapses the
 * boilerplate `fieldsOf` body shared by the simpler connectors.
 */
export function fieldsFromKeys(
  keys: readonly string[],
  opts?: { readonly tags?: boolean },
): FieldExtractor {
  return keyedFields(asObjectish, keys, opts?.tags === true);
}

/**
 * {@link fieldsFromKeys} for rows that must be plain objects: an ARRAY row is skipped
 * ({@link asRecord}) instead of being read as an object that has none of the keys — which a
 * query made only of spaces would still match. The BI connectors' filters use this rule.
 */
export function recordFieldsFromKeys(keys: readonly string[]): FieldExtractor {
  return keyedFields(asRecord, keys, false);
}

/**
 * Read a nested string field by key path off an objectish row, returning `""`
 * when any path segment is missing or the leaf is not a string. Shared by the
 * Kubernetes-style connectors (argocd, flux) whose resources nest fields under
 * `metadata` / `spec` / `status`.
 */
export function nestedString(root: Record<string, unknown>, path: readonly string[]): string {
  let cur: Record<string, unknown> | undefined = root;
  for (let i = 0; i < path.length - 1; i += 1) {
    cur = asRecord(cur?.[path[i] ?? ""]);
    if (cur === undefined) {
      return "";
    }
  }
  const leaf = cur?.[path.at(-1) ?? ""];
  return typeof leaf === "string" ? leaf : "";
}

/**
 * Build a `filter<Thing>(items, options)` search function from a field
 * extractor. Connectors with bespoke extraction pass their own `fieldsOf`;
 * simple ones pair this with {@link fieldsFromKeys}.
 */
export function makeQueryFilter(
  fields: FieldExtractor,
): (items: readonly unknown[], options: SearchMatchOptions) => unknown[] {
  return (items, options) => filterByQuery(items, { ...options, fields });
}
