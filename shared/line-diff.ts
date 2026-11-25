/**
 * line-diff: a pure unified diff of two lists of lines (Myers' O(ND) shortest edit script).
 *
 * It exists so a tool can show an approver exactly what will change without starting a `diff`
 * program: Windows ships none, and a program the environment names is not one to trust with the text
 * an owner approves. Equal inputs give "". The output has the two header lines, then one hunk
 * `@@ -a,b +c,d @@` per run of changes with `context` lines either side (hunks whose context touches
 * are merged), every line ending with "\n". Counts are always written, `,1` included.
 *
 * Bounded: an edit script longer than {@link MAX_EDIT_DISTANCE} throws {@link LineDiffTooLargeError}
 * (the caller refuses, it never cuts), so a pathological input cannot hold memory or the event loop.
 */

export const MAX_EDIT_DISTANCE = 2000;

/** `V[j]` from a trace window that holds `V[-d..d]` (index `j + d`); 0 outside it. */
function at(window: Int32Array, d: number, j: number): number {
  return j < -d || j > d ? 0 : (window[j + d] ?? 0);
}

export class LineDiffTooLargeError extends Error {
  constructor() {
    super("the two sides differ by too many lines to diff");
    this.name = "LineDiffTooLargeError";
  }
}

type Op = { readonly kind: " " | "-" | "+"; readonly text: string };

/** The edit script from `a` to `b`: the equal prefix and suffix are peeled off, Myers does the rest. */
function editScript(a: readonly string[], b: readonly string[]): Op[] {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA -= 1;
    endB -= 1;
  }
  const head: Op[] = a.slice(0, start).map((text) => ({ kind: " ", text }));
  const tail: Op[] = a.slice(endA).map((text) => ({ kind: " ", text }));
  return [...head, ...myers(a.slice(start, endA), b.slice(start, endB)), ...tail];
}

function myers(a: readonly string[], b: readonly string[]): Op[] {
  if (a.length === 0) return b.map((text) => ({ kind: "+", text }));
  if (b.length === 0) return a.map((text) => ({ kind: "-", text }));
  const { trace, found } = forwardSearch(a, b);
  return walkBack(a, b, trace, found);
}

/**
 * Myers' forward pass: the trace of V windows and the edit distance `found`. trace[d] is V[-d..d]
 * as it stood BEFORE step d (index k + d), all the walk back reads. Storing the whole V at every
 * step would hold (max + 1) * (2 * max + 3) values; the window holds about max * max, 16 MB at the
 * bound. Throws {@link LineDiffTooLargeError} past {@link MAX_EDIT_DISTANCE}.
 */
function forwardSearch(
  a: readonly string[],
  b: readonly string[],
): { trace: Int32Array[]; found: number } {
  const max = Math.min(a.length + b.length, MAX_EDIT_DISTANCE);
  const offset = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  for (let d = 0; d <= max; d += 1) {
    trace.push(v.slice(offset - d, offset + d + 1));
    if (forwardStep(a, b, v, offset, d)) return { trace, found: d };
  }
  throw new LineDiffTooLargeError();
}

/** Step `d` of the forward pass, updating `v` in place; true when it reaches the end of both sides. */
function forwardStep(
  a: readonly string[],
  b: readonly string[],
  v: Int32Array,
  offset: number,
  d: number,
): boolean {
  for (let k = -d; k <= d; k += 2) {
    const down = k === -d || (k !== d && (v[offset + k - 1] ?? 0) < (v[offset + k + 1] ?? 0));
    let x = down ? (v[offset + k + 1] ?? 0) : (v[offset + k - 1] ?? 0) + 1;
    let y = x - k;
    while (x < a.length && y < b.length && a[x] === b[y]) {
      x += 1;
      y += 1;
    }
    v[offset + k] = x;
    if (x >= a.length && y >= b.length) return true;
  }
  return false;
}

/** Myers' walk back from the end of both sides through `trace`, as the edit script in order. */
function walkBack(
  a: readonly string[],
  b: readonly string[],
  trace: readonly Int32Array[],
  found: number,
): Op[] {
  const ops: Op[] = [];
  let x = a.length;
  let y = b.length;
  for (let d = found; d > 0; d -= 1) {
    const prev = trace[d];
    if (prev === undefined) throw new LineDiffTooLargeError();
    const k = x - y;
    const down = k === -d || (k !== d && at(prev, d, k - 1) < at(prev, d, k + 1));
    const prevK = down ? k + 1 : k - 1;
    const prevX = at(prev, d, prevK);
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      x -= 1;
      y -= 1;
      ops.push({ kind: " ", text: a[x] ?? "" });
    }
    if (down) {
      y -= 1;
      ops.push({ kind: "+", text: b[y] ?? "" });
    } else {
      x -= 1;
      ops.push({ kind: "-", text: a[x] ?? "" });
    }
  }
  while (x > 0 && y > 0) {
    x -= 1;
    y -= 1;
    ops.push({ kind: " ", text: a[x] ?? "" });
  }
  return ops.reverse();
}

/** The changes grouped into hunks: [first, last] indexes into `ops`, widened by `context`. */
function hunkRanges(ops: readonly Op[], context: number): [number, number][] {
  const ranges: [number, number][] = [];
  ops.forEach((op, i) => {
    if (op.kind === " ") return;
    const lo = Math.max(0, i - context);
    const hi = Math.min(ops.length - 1, i + context);
    const last = ranges.at(-1);
    if (last !== undefined && lo <= last[1] + 1) last[1] = hi;
    else ranges.push([lo, hi]);
  });
  return ranges;
}

/** Lines of each side consumed before each op, so a hunk's start is a lookup. */
function linesBefore(ops: readonly Op[]): { aBefore: number[]; bBefore: number[] } {
  const aBefore: number[] = [];
  const bBefore: number[] = [];
  let ai = 0;
  let bi = 0;
  for (const op of ops) {
    aBefore.push(ai);
    bBefore.push(bi);
    if (op.kind !== "+") ai += 1;
    if (op.kind !== "-") bi += 1;
  }
  return { aBefore, bBefore };
}

export function unifiedLineDiff(
  from: readonly string[],
  to: readonly string[],
  opts: {
    readonly fromLabel: string;
    readonly toLabel: string;
    readonly context?: number | undefined;
  },
): string {
  const context = opts.context ?? 3;
  const ops = editScript(from, to);
  const ranges = hunkRanges(ops, context);
  if (ranges.length === 0) return "";
  const { aBefore, bBefore } = linesBefore(ops);

  const out = [`--- ${opts.fromLabel}`, `+++ ${opts.toLabel}`];
  for (const [lo, hi] of ranges) {
    const slice = ops.slice(lo, hi + 1);
    const aCount = slice.filter((o) => o.kind !== "+").length;
    const bCount = slice.filter((o) => o.kind !== "-").length;
    const aStart = (aBefore[lo] ?? 0) + (aCount === 0 ? 0 : 1);
    const bStart = (bBefore[lo] ?? 0) + (bCount === 0 ? 0 : 1);
    out.push(`@@ -${String(aStart)},${String(aCount)} +${String(bStart)},${String(bCount)} @@`);
    for (const op of slice) out.push(`${op.kind}${op.text}`);
  }
  return `${out.join("\n")}\n`;
}
