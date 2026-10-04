/** The variable that sets how many mutations a standalone connector may perform in one session. */
export const WRITE_BUDGET_ENV = "NIMBUS_MCP_WRITE_BUDGET";

/** Mutations allowed per process lifetime when `NIMBUS_MCP_WRITE_BUDGET` is unset or empty. */
export const DEFAULT_WRITE_BUDGET = 10;

/**
 * The largest budget accepted, `2 ** 53 - 1`.
 *
 * Above it the registrar's per-mutation `remaining -= 1` stops counting one at a time: `2 ** 54 - 1`
 * rounds back to `2 ** 54`, so a budget that large would never run out. That is an unlimited cap
 * spelled as a number, and it is refused like any other value that cannot be enforced as written.
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
      `${String(MAX_WRITE_BUDGET)}, where 0 refuses every write; unset or empty means the ` +
      `default, ${String(DEFAULT_WRITE_BUDGET)}`,
  );
}

/**
 * Parse `NIMBUS_MCP_WRITE_BUDGET` into the number of mutations a session may perform.
 *
 * STRICT, and an invalid value THROWS at startup, the same treatment `parseWriteScope` gives a
 * malformed scope term. The budget used to be read with `Number()`, and that failed open:
 * `Number("abc")` is `NaN`, `NaN <= 0` is false, so the budget never ran out. Measured on argocd
 * standalone with 25 approved syncs, unset allowed 10 while `abc`, `ten` and `Infinity` each
 * allowed all 25.
 *
 * Throwing rather than falling back to the default is deliberate. A fallback still runs under a
 * cap the operator did not write, and it can be a LARGER one: an operator who wrote `none` or
 * `zero` meant no writes at all and would get ten. A typo in a security setting should stop the
 * connector, which the client reports as a failed server, not be repaired behind a stderr warning
 * the operator may never see.
 *
 * Accepted: plain decimal digits, after trimming, from `0` (every write refuses) to
 * `MAX_WRITE_BUDGET`. Unset, empty and whitespace-only all mean `DEFAULT_WRITE_BUDGET`, the reading
 * every other variable in this package gives an empty value. Everything else throws: a sign, a
 * fraction (even `10.0`), an exponent, a hex or separator spelling, `Infinity`, and any number too
 * large to count down exactly.
 */
export function parseWriteBudget(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_WRITE_BUDGET;
  const text = raw.trim();
  if (text === "") return DEFAULT_WRITE_BUDGET;
  // Digits are checked BEFORE `Number()` sees the text: it would read `1e3`, `0x10`, `+5` and
  // `10.0` as numbers the operator never wrote, and `Infinity` as no limit at all.
  if (!DIGITS.test(text)) throw invalidBudget(raw);
  // Never NaN here, since the text is all digits; a long enough run of them is `Infinity`, which
  // this comparison refuses along with every other value too large to count down exactly.
  const n = Number(text);
  if (n > MAX_WRITE_BUDGET) throw invalidBudget(raw);
  return n;
}
