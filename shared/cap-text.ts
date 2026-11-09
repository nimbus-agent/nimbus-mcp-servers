/** Longest vendor string a read projection returns, in UTF-16 code units. */
export const MAX_VENDOR_TEXT = 500;

/** Appended to a string that was cut, so a reader can tell it is not the whole value. */
export const TRUNCATION_MARKER = "...[truncated]";

/**
 * A vendor string capped at `max` characters, with an explicit marker when it was cut; `undefined`
 * for anything that is not a non-empty string. Read projections use it so one unbounded field
 * (an error message, a commit message) cannot flood the model's context.
 */
export function capText(value: unknown, max: number = MAX_VENDOR_TEXT): string | undefined {
  if (typeof value !== "string" || value === "") return undefined;
  return value.length <= max ? value : `${value.slice(0, max)}${TRUNCATION_MARKER}`;
}
