/**
 * The gate for a connector's LIVE write sandbox test: a test in `test/sandbox.test.ts` that makes
 * real writes to a throwaway resource the owner created and names by environment variable.
 *
 * It runs only under `bun run test:sandbox` (which sets `NIMBUS_TEST_HARNESS`, like the sandbox
 * contract test beside it) AND only when every variable it needs is set. Otherwise it is skipped,
 * and under the harness the skip is announced on stderr with the variables that are missing, so a
 * run with no credentials reads as "skipped, set X" rather than as a pass. In the ordinary
 * `bun test` it is skipped silently, as the sandbox contract test is.
 *
 * No credential is ever read from anywhere but the environment, and none is printed: the skip line
 * names variables, never their values.
 */

/** What a live sandbox test needs to know before it decides to run. */
export interface LiveSandboxGate {
  /** True only under the harness with every required variable set (non-blank). */
  readonly enabled: boolean;
  /** The required variables that are unset or blank. */
  readonly missing: readonly string[];
  /** The describe title, with the skip reason appended when the test will not run. */
  readonly title: string;
  /** The required variables' values. Read only when `enabled`; a missing one is `""`. */
  readonly values: Readonly<Record<string, string>>;
}

/**
 * Decide whether the live test titled `title` runs, from `required` variable names. `log` and
 * `env` are injected for this module's own test.
 */
export function liveSandboxGate(
  title: string,
  required: readonly string[],
  env: Readonly<Record<string, string | undefined>> = process.env,
  log: (line: string) => void = (line) => {
    console.error(line);
  },
): LiveSandboxGate {
  const harness = (env["NIMBUS_TEST_HARNESS"] ?? "") !== "";
  const values: Record<string, string> = {};
  const missing: string[] = [];
  for (const name of required) {
    const value = (env[name] ?? "").trim();
    values[name] = value;
    if (value === "") missing.push(name);
  }
  const enabled = harness && missing.length === 0;
  if (!harness) {
    return {
      enabled,
      missing,
      title: `${title} (skipped: only under bun run test:sandbox)`,
      values,
    };
  }
  if (missing.length > 0) {
    const reason = `skipped: set ${missing.join(", ")}`;
    log(`[live sandbox] ${title}: ${reason}`);
    return { enabled, missing, title: `${title} (${reason})`, values };
  }
  return { enabled, missing, title, values };
}

/**
 * A name no real resource has: `nimbus-sandbox-<timestamp>`, with `suffix` when one run makes
 * several. Plain ASCII, so it is valid wherever a summary or label is.
 */
export function sandboxName(suffix?: string, now: number = Date.now()): string {
  return suffix === undefined
    ? `nimbus-sandbox-${String(now)}`
    : `nimbus-sandbox-${String(now)}-${suffix}`;
}

/**
 * Run `cleanup` after `body`, even when `body` throws. A cleanup failure is reported on stderr with
 * `what` (so the owner knows which throwaway resource to fix by hand; a function is read only then,
 * so it can name an id the body learned) and rethrown only when the
 * body itself succeeded: the body's own failure is the one worth reading first.
 */
export async function withCleanup<T>(
  what: string | (() => string),
  body: () => Promise<T>,
  cleanup: () => Promise<void>,
  log: (line: string) => void = (line) => {
    console.error(line);
  },
): Promise<T> {
  const cleaned = async (): Promise<unknown> => {
    try {
      await cleanup();
      return undefined;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const label = typeof what === "string" ? what : what();
      log(`[live sandbox] CLEANUP FAILED, fix by hand: ${label}: ${message}`);
      return err ?? new Error("cleanup failed");
    }
  };
  let result: T;
  try {
    result = await body();
  } catch (err) {
    await cleaned();
    throw err;
  }
  const cleanupError = await cleaned();
  if (cleanupError !== undefined) throw cleanupError;
  return result;
}
