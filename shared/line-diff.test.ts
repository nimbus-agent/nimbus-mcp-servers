import { describe, expect, it } from "bun:test";
import { LineDiffTooLargeError, unifiedLineDiff } from "./line-diff.ts";

const diff = (a: string[], b: string[]) =>
  unifiedLineDiff(a, b, { fromLabel: "live x", toLabel: "planned x" });

describe("unifiedLineDiff", () => {
  it("is empty for equal inputs, and for two empty ones", () => {
    expect(diff(["a", "b"], ["a", "b"])).toBe("");
    expect(diff([], [])).toBe("");
  });

  it("renders a change with its context and a hunk header", () => {
    expect(diff(["a", "b", "c"], ["a", "B", "c"])).toBe(
      ["--- live x", "+++ planned x", "@@ -1,3 +1,3 @@", " a", "-b", "+B", " c", ""].join("\n"),
    );
  });

  it("renders a replacement of a whole side", () => {
    expect(diff(["gone"], ["p", "q"])).toBe(
      ["--- live x", "+++ planned x", "@@ -1,1 +1,2 @@", "-gone", "+p", "+q", ""].join("\n"),
    );
  });

  it("keeps three lines of context and splits distant changes into two hunks", () => {
    const a = Array.from({ length: 20 }, (_, i) => `l${String(i)}`);
    const b = [...a];
    b[2] = "X";
    b[17] = "Y";
    expect(diff(a, b)).toBe(
      [
        "--- live x",
        "+++ planned x",
        "@@ -1,6 +1,6 @@",
        " l0",
        " l1",
        "-l2",
        "+X",
        " l3",
        " l4",
        " l5",
        "@@ -15,6 +15,6 @@",
        " l14",
        " l15",
        " l16",
        "-l17",
        "+Y",
        " l18",
        " l19",
        "",
      ].join("\n"),
    );
  });

  it("merges changes whose context touches into one hunk", () => {
    const out = diff(["a", "b", "c", "d", "e", "f", "g"], ["a", "B", "c", "d", "e", "F", "g"]);
    expect(out.match(/^@@/gm)).toHaveLength(1);
  });

  it("emits a script that rebuilds both sides (the classic Myers example)", () => {
    const a = ["a", "b", "c", "a", "b", "b", "a"];
    const b = ["c", "b", "a", "b", "a", "c"];
    const body = diff(a, b).split("\n").slice(2);
    const lines = body.filter((l) => l !== "" && !l.startsWith("@@"));
    expect(lines.filter((l) => l[0] !== "+").map((l) => l.slice(1))).toEqual(a);
    expect(lines.filter((l) => l[0] !== "-").map((l) => l.slice(1))).toEqual(b);
  });

  it("refuses an edit script longer than the bound, instead of working without end", () => {
    const a = Array.from({ length: 6000 }, (_, i) => `a${String(i)}`);
    const b = Array.from({ length: 6000 }, (_, i) => `b${String(i)}`);
    expect(() => diff(a, b)).toThrow(LineDiffTooLargeError);
  });
});
