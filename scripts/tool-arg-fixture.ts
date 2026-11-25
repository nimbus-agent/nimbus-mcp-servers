/**
 * tool-arg-fixture — synthesise the smallest argument object a connector tool's
 * Zod schema accepts.
 *
 * The connector contract test has to CALL every tool, and every tool declares
 * its own schema. Hand-writing an argument fixture per tool would be ~250
 * literals that go stale silently the moment a schema changes; deriving one from
 * the schema cannot go stale, because a schema change immediately changes what
 * this produces.
 *
 * It works by repair rather than by introspection: start from `{}`, ask the
 * schema what is wrong, patch exactly those complaints, and ask again. That
 * keeps it independent of Zod's internal `_def` layout, which is not a stable
 * API and which changed shape between major versions.
 */

/** The subset of a Zod schema this needs. */
export interface ParsableSchema {
  safeParse: (value: unknown) => { success: boolean; error?: { issues: readonly ZodIssue[] } };
}

interface ZodIssue {
  readonly code: string;
  readonly path: readonly PropertyKey[];
  readonly expected?: string;
  readonly minimum?: number | bigint;
  readonly maximum?: number | bigint;
  readonly options?: readonly unknown[];
  readonly values?: readonly unknown[];
  readonly origin?: string;
}

const MAX_REPAIRS = 24;

function minimumOf(issue: ZodIssue): number {
  return typeof issue.minimum === "bigint" ? Number(issue.minimum) : (issue.minimum ?? 1);
}

function maximumOf(issue: ZodIssue): number {
  return typeof issue.maximum === "bigint" ? Number(issue.maximum) : (issue.maximum ?? 1);
}

/** A value that plausibly answers one complaint, or undefined when unguessable. */
function candidate(issue: ZodIssue, current: unknown): unknown {
  if (issue.code === "invalid_value" || issue.code === "invalid_enum_value") {
    return (issue.values ?? issue.options ?? [])[0];
  }
  if (issue.code === "too_small") {
    const min = minimumOf(issue);
    if (typeof current === "string" || issue.origin === "string" || issue.expected === "string") {
      return "x".repeat(Math.max(min, 1));
    }
    if (Array.isArray(current) || issue.origin === "array") {
      return Array.from({ length: Math.max(min, 1) }, () => "x");
    }
    return Math.max(min, 1);
  }
  if (issue.code === "too_big") {
    const max = maximumOf(issue);
    if (typeof current === "string") {
      return current.slice(0, max);
    }
    if (typeof current === "number") {
      return Math.min(current, max);
    }
    return current;
  }
  const expected = issue.expected ?? (issue.code === "invalid_type" ? "string" : undefined);
  switch (expected) {
    case "string":
      return "x";
    case "number":
    case "int":
    case "bigint":
      return 1;
    case "boolean":
      return true;
    case "array":
      return ["x"];
    case "object":
      return {};
    default:
      // A format constraint (email, url, regex) on a value already the right
      // type: nothing generic can satisfy it, so the caller is told.
      return undefined;
  }
}

/**
 * The smallest object `schema` accepts, starting from `seed`, or `undefined`
 * when no generic value satisfies it (a URL/email format, a cross-field
 * refinement). Callers treat `undefined` as "this tool needs a hand-written
 * fixture", never as a pass.
 */
export function fixtureFor(
  schema: ParsableSchema,
  seed: Record<string, unknown> = {},
): Record<string, unknown> | undefined {
  // The seed carries values no schema can describe — a UUID, a Firebase app id.
  // A plain `z.object` strips keys it does not declare, so seeding a value the
  // tool does not take is harmless.
  const args: Record<string, unknown> = { ...seed };
  for (let attempt = 0; attempt < MAX_REPAIRS; attempt++) {
    const result = schema.safeParse(args);
    if (result.success) {
      return args;
    }
    let repaired = false;
    for (const issue of result.error?.issues ?? []) {
      // Every issue is patched, whether or not an earlier one already was.
      const patched = repairIssue(args, issue);
      repaired = repaired || patched;
    }
    if (!repaired) {
      return undefined;
    }
  }
  return undefined;
}

/** Patch the one value `issue` complains about, in place; true when something changed. */
function repairIssue(args: Record<string, unknown>, issue: ZodIssue): boolean {
  const key = issue.path[0];
  if (typeof key !== "string") {
    return false;
  }
  // One level deeper is an element of an array argument (`[0]`): a list of numbers is first
  // seeded with the string every list is, and the element's own complaint fixes its type.
  const index = issue.path[1];
  const list = args[key];
  if (issue.path.length === 2 && typeof index === "number" && Array.isArray(list)) {
    return replaceIfChanged(list, index, candidate(issue, list[index]));
  }
  if (issue.path.length !== 1) {
    return false;
  }
  return replaceIfChanged(args, key, candidate(issue, args[key]));
}

/** Store `next` at `holder[slot]` unless it is undefined or the value already there. */
function replaceIfChanged<K extends string | number>(
  holder: { [slot in K]?: unknown },
  slot: K,
  next: unknown,
): boolean {
  if (next === undefined || Object.is(next, holder[slot])) {
    return false;
  }
  holder[slot] = next;
  return true;
}
