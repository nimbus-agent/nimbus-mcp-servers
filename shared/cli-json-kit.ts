/**
 * cli-json-kit — the shared pieces of the CLI-backed connectors.
 *
 * Five connectors reach their service by spawning a cloud CLI and parsing its
 * JSON (athena, cloudwatch and sagemaker through `aws`; cloud-logging and
 * vertex-ai through `gcloud`), and each had written out the same three things:
 *
 *   - the `cliArg` Zod refinement that rejects an argument starting with `-`
 *     (argv flag smuggling) or carrying control characters;
 *   - a `runX` wrapper: spawn, trim, throw `"<label> <verb> failed: <stderr>"`
 *     on a non-zero exit, otherwise `JSON.parse` the stdout;
 *   - `isRecord` / `strField` / `asArray`, the untyped-payload readers used to
 *     walk the parsed result.
 *
 * The argument guard is the reason this is worth sharing rather than tolerating:
 * it is a security control, and a security control that exists in five
 * hand-written copies is one that can be strengthened in four of them.
 */

import { z } from "zod";
import { isSafeCliArg } from "./safe-cli-arg.ts";

/** Body-snippet length in the thrown error. The value every connector used. */
export const DEFAULT_STDERR_SNIPPET = 400;

/**
 * A value passed to a CLI as an argument.
 *
 * Rejected at the SCHEMA boundary, before the value can reach argv: a leading
 * `-` would be read by the CLI as a flag rather than as the name it is meant to
 * be, and control characters have no legitimate place in one.
 */
export const cliArg = z
  .string()
  .min(1)
  .refine(isSafeCliArg, { message: 'must not start with "-" or contain control characters' });

/** The spawn seam. Production passes `nimbusSpawn`; tests pass a fake. */
export type SpawnFn = (
  command: readonly string[],
  env: Record<string, string | undefined>,
) => Promise<{ code: number; stdout: string; stderr: string }>;

export interface CliJsonRunnerConfig {
  /**
   * Builds the full argv for one call. Given the connector's own arguments, it
   * returns the complete command — binary, subcommand, arguments and whatever
   * output flag that CLI needs (`--output json` for aws, `--format json` for
   * gcloud).
   */
  readonly argv: (args: readonly string[]) => readonly string[];
  /** Prefix for the thrown error, e.g. `"aws athena"`. */
  readonly label: string;
  /**
   * What empty stdout means. The `aws` connectors treat it as `{}` and the
   * `gcloud` ones as `[]`, because that is the shape each CLI omits when there
   * is nothing to report.
   */
  readonly emptyResult: unknown;
  /** Extra environment for the spawn. Defaults to none — the CLI reads its own. */
  readonly env?: () => Record<string, string | undefined>;
  readonly snippetMax?: number;
}

/**
 * A `(args) => Promise<unknown>` runner for one CLI.
 *
 * Throws `"<label> <first arg> failed: <stderr snippet>"` on a non-zero exit,
 * so a caller sees which subcommand failed and why.
 */
export function createCliJsonRunner(
  config: CliJsonRunnerConfig,
  spawn: SpawnFn,
): (args: readonly string[]) => Promise<unknown> {
  const snippetMax = config.snippetMax ?? DEFAULT_STDERR_SNIPPET;
  return async (args: readonly string[]): Promise<unknown> => {
    const { code, stdout, stderr } = await spawn(config.argv(args), config.env?.() ?? {});
    const out = stdout.trim();
    if (code !== 0) {
      throw new Error(
        `${config.label} ${args[0] ?? ""} failed: ${stderr.trim().slice(0, snippetMax)}`,
      );
    }
    return out === "" ? config.emptyResult : (JSON.parse(out) as unknown);
  };
}

// ---------------------------------------------------------------------------
// Untyped-payload readers
//
// External CLI output is `unknown` at the boundary (Non-Negotiable #5), and
// these three are how every one of these connectors narrows it.
// ---------------------------------------------------------------------------

/** A non-null, non-array object. */
export function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** `r[key]` when it is a string, else `""` — never `undefined`, never a throw. */
export function strField(r: Record<string, unknown>, key: string): string {
  const v = r[key];
  return typeof v === "string" ? v : "";
}

/** `parsed[key]` when `parsed` is a record and the value is an array, else `[]`. */
export function asArray(parsed: unknown, key: string): unknown[] {
  if (!isRecord(parsed)) {
    return [];
  }
  const arr = parsed[key];
  return Array.isArray(arr) ? arr : [];
}

/** Case-insensitive substring match on one string field of an untyped entry. */
export function fieldMatches(entry: unknown, key: string, query: string): boolean {
  return isRecord(entry) && strField(entry, key).toLowerCase().includes(query.toLowerCase());
}
