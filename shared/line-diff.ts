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

export const MAX_EDIT_DISTANCE = 5000;

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
  const n = a.length;
  const m = b.length;
  if (n === 0) return b.map((text) => ({ kind: "+", text }));
  if (m === 0) return a.map((text) => ({ kind: "-", text }));
  const max = Math.min(n + m, MAX_EDIT_DISTANCE);
  const offset = max + 1;
  const v = new Int32Array(2 * max + 3);
  // trace[d] is V as it stood BEFORE step d, which is what the walk back needs.
  const trace: Int32Array[] = [];
  let found = -1;
  for (let d = 0; d <= max && found < 0; d += 1) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      const down = k === -d || (k !== d && (v[offset + k - 1] ?? 0) < (v[offset + k + 1] ?? 0));
      let x = down ? (v[offset + k + 1] ?? 0) : (v[offset + k - 1] ?? 0) + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x += 1;
        y += 1;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) {
        found = d;
        break;
      }
    }
  }
  if (found < 0) throw new LineDiffTooLargeError();
  const ops: Op[] = [];
  let x = n;
  let y = m;
  for (let d = found; d > 0; d -= 1) {
    const prev = trace[d];
    if (prev === undefined) throw new LineDiffTooLargeError();
    const k = x - y;
    const down = k === -d || (k !== d && (prev[offset + k - 1] ?? 0) < (prev[offset + k + 1] ?? 0));
    const prevK = down ? k + 1 : k - 1;
    const prevX = prev[offset + prevK] ?? 0;
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
  const changed: number[] = [];
  ops.forEach((op, i) => {
    if (op.kind !== " ") changed.push(i);
  });
  if (changed.length === 0) return "";

  // Group the changes into hunks: [first, last] indexes into ops, widened by the context.
  const ranges: [number, number][] = [];
  for (const i of changed) {
    const lo = Math.max(0, i - context);
    const hi = Math.min(ops.length - 1, i + context);
    const last = ranges[ranges.length - 1];
    if (last !== undefined && lo <= last[1] + 1) last[1] = hi;
    else ranges.push([lo, hi]);
  }

  // Lines of each side consumed before each op, so a hunk's start is a lookup.
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
