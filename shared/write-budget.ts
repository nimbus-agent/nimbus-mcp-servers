/** The variable that sets how many mutations a standalone connector may perform in one session. */
export const WRITE_BUDGET_ENV = "NIMBUS_MCP_WRITE_BUDGET";

/** Mutations allowed per process lifetime when `NIMBUS_MCP_WRITE_BUDGET` is unset. */
export const DEFAULT_WRITE_BUDGET = 10;

/**
 * The largest budget accepted, `2 ** 53 - 1`, which is `Number.MAX_SAFE_INTEGER`.
 *
 * Above it a budget stops counting down one mutation at a time: `2 ** 54 - 1` rounds back to
 * `2 ** 54`, so a budget that large would never run out. That is an unlimited cap spelled as a
 * number, and it is refused like any other value that cannot be enforced as written.
 */
export const MAX_WRITE_BUDGET = Number.MAX_SAFE_INTEGER;

/**
 * Plain decimal digits: no sign, fraction, exponent, `0x` prefix, separator or `Infinity`. In a
 * JavaScript regex `\d` is ASCII `0`-`9` only, with or without the `u` flag, so a digit from
 * another script does not match.
 */
const DIGITS = /^\d+$/;

function invalidBudget(raw: string): Error {
  return new Error(
    `${WRITE_BUDGET_ENV}=${JSON.stringify(raw)}: expected a whole number of mutations from 0 to ` +
      `${String(MAX_WRITE_BUDGET)}, where 0 refuses every write; leave it unset for the default, ` +
      `${String(DEFAULT_WRITE_BUDGET)}`,
  );
}

/**
 * Parse `NIMBUS_MCP_WRITE_BUDGET` into the number of mutations a session may perform.
 *
 * STRICT, and an invalid value THROWS at startup, as `parseWriteScope` does on a malformed scope
 * term. The budget used to be read with `Number()`, and that failed open: `Number("abc")` is
 * `NaN`, `NaN <= 0` is false, so the budget never ran out. Measured on argocd standalone with 25
 * approved syncs, unset allowed 10 while `abc`, `ten` and `Infinity` each allowed all 25.
 *
 * Throwing rather than falling back to the default is deliberate. A fallback still runs under a
 * cap the operator did not write, and it can be a LARGER one: an operator who wrote `none` or
 * `zero` meant no writes at all and would get ten. A typo in a security setting should stop the
 * connector, which the client reports as a failed server, not be repaired behind a stderr warning
 * the operator may never see.
 *
 * Accepted: unset, meaning `DEFAULT_WRITE_BUDGET`, or plain decimal digits from `0` (every write
 * refuses) to `MAX_WRITE_BUDGET`, whitespace around them ignored. Everything else throws: a sign,
 * a fraction (even `10.0`), an exponent, a hex or separator spelling, `Infinity`, a number too
 * large to count down exactly, and an EMPTY or whitespace-only value. Every other variable in this
 * package reads empty as unset, but here that reading is not the safe one: `Number("")` is 0, so
 * an empty budget allowed no writes, and reading it as unset would silently raise it to ten. Empty
 * is as likely to mean "none" as "the default", so it is refused rather than guessed at.
 */
export function parseWriteBudget(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_WRITE_BUDGET;
  const text = raw.trim();
  // Digits are checked BEFORE `Number()` sees the text: it would read `1e3`, `0x10`, `+5` and
  // `10.0` as numbers the operator never wrote, `Infinity` as no limit at all, and an empty value
  // as 0.
  if (!DIGITS.test(text)) throw invalidBudget(raw);
  // All digits, so never NaN or negative, but a long enough run of them is above the largest safe
  // integer or is `Infinity`. Only a safe integer passes, so what comes out can be counted down
  // exactly, one mutation at a time.
  const n = Number(text);
  if (!Number.isSafeInteger(n)) throw invalidBudget(raw);
  return n;
}

/**
 * A session's write budget: how many more mutations it may perform.
 *
 * The count lives here and nowhere else, so nothing outside can assign it, and its one check,
 * `hasLeft`, passes only a positive safe integer. `parseWriteBudget` yields nothing but a safe
 * whole number, but the check does not rely on that: the count was once tested as
 * `remaining <= 0`, which is false for NaN, so a NaN count never ran out. Written this way, a NaN,
 * an `Infinity` or a fraction allows no writes at all, wherever it came from.
 */
export type WriteBudget = {
  /** Whether at least one mutation is left. */
  hasLeft(): boolean;
  /**
   * Spend one mutation if one is left, and report whether one was. The check and the decrement
   * are one synchronous call, so calls in flight together cannot all pass the check before any
   * of them spends.
   */
  take(): boolean;
};

/** A budget of `limit` mutations, `limit` being what `parseWriteBudget` returned. */
export function createWriteBudget(limit: number): WriteBudget {
  let remaining = limit;
  const hasLeft = (): boolean => Number.isSafeInteger(remaining) && remaining > 0;
  return {
    hasLeft,
    take(): boolean {
      if (!hasLeft()) return false;
      remaining -= 1;
      return true;
    },
  };
}
