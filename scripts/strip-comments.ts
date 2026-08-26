/**
 * Comment stripping for the connector-entrypoint audit.
 *
 * Ported verbatim from the Nimbus monorepo's scripts/structure-audit/lib.ts, limitation included —
 * see stripComments below. Carried across rather than reimplemented so the audit that depends on it
 * behaves identically in both repositories.
 */

type StringDelim = '"' | "'" | "`";

type StripState = {
  i: number;
  out: string;
  inString: StringDelim | null;
  done: boolean;
};

function stepInString(src: string, state: StripState): void {
  const c = src[state.i] as string;
  const next = src[state.i + 1];
  state.out += c;
  if (c === "\\") {
    if (next !== undefined) state.out += next;
    state.i += 2;
    return;
  }
  if (c === state.inString) state.inString = null;
  state.i += 1;
}

function stepDefault(src: string, state: StripState): void {
  const c = src[state.i] as string;
  const next = src[state.i + 1];
  if (c === "/" && next === "*") {
    const end = src.indexOf("*/", state.i + 2);
    if (end === -1) {
      state.done = true;
      return;
    }
    const block = src.slice(state.i, end + 2);
    for (const ch of block) {
      if (ch === "\n") state.out += "\n";
    }
    state.i = end + 2;
    return;
  }
  if (c === "/" && next === "/") {
    const nl = src.indexOf("\n", state.i);
    if (nl === -1) {
      state.done = true;
      return;
    }
    state.i = nl;
    return;
  }
  if (c === '"' || c === "'" || c === "`") {
    state.inString = c;
    state.out += c;
    state.i += 1;
    return;
  }
  state.out += c;
  state.i += 1;
}

/**
 * Remove comments from TypeScript source.
 *
 * KNOWN LIMITATION — no regex-literal awareness. The scanner tracks `"`, `'` and `` ` `` but does
 * not recognise a regex literal, so a quote character INSIDE one opens a phantom string and every
 * comment after it survives unstripped. Verified minimal case:
 *
 * ```ts
 * const RE = /(["|]) /;
 * /** this whole comment survives stripComments *\/
 * ```
 *
 * Measured against the tree on 2026-08-23: of the 94 connector `src/server.ts` files, exactly ONE
 * desyncs — `snowflake`, on `/^(?:[A-Za-z_][A-Za-z0-9_$]*|"[^"]+")$/` — and it changes NO audit
 * verdict, because snowflake both guards on `import.meta.main` and exports `startConnector`. So
 * `check-connector-entrypoints` is correct today by luck, not by construction: a connector that
 * adds a quote-bearing regex AND has the guard-without-export shape would be silently passed.
 * `test:connector-boot` still catches the resulting dead connector, which is why this is recorded
 * rather than fixed.
 *
 * Fixing it means disambiguating `/`-as-regex from `/`-as-division (standard heuristic: a `/`
 * starts a regex unless the preceding token is an identifier, literal or closing bracket). That is
 * worth doing the next time someone is in this file with reason to; it was judged a poor trade to
 * hand-roll lexer heuristics into a helper three passing audits depend on, for a latent issue with
 * a backstop.
 *
 * If you need comment-stripping for a NEW guard, consider whether a line-based skip suffices —
 * `check-connector-consent.ts` uses one. Note the trade: line-based handles block comments and
 * misses TRAILING ones (`const x = 1; // marker`), which this function handles correctly.
 */
export function stripComments(src: string): string {
  const state: StripState = { i: 0, out: "", inString: null, done: false };
  while (!state.done && state.i < src.length) {
    if (state.inString) {
      stepInString(src, state);
    } else {
      stepDefault(src, state);
    }
  }
  return state.out;
}
