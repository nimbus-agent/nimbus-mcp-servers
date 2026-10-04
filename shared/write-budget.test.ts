import { describe, expect, test } from "bun:test";

import {
  createWriteBudget,
  DEFAULT_WRITE_BUDGET,
  MAX_WRITE_BUDGET,
  parseWriteBudget,
  WRITE_BUDGET_ENV,
  type WriteBudget,
} from "./write-budget.ts";

describe("parseWriteBudget", () => {
  test("an unset budget is the documented default of 10", () => {
    expect(parseWriteBudget(undefined)).toBe(DEFAULT_WRITE_BUDGET);
    expect(DEFAULT_WRITE_BUDGET).toBe(10);
  });

  test("an empty or whitespace-only value throws rather than being read as unset", () => {
    // Read with `Number()`, a blank budget was 0, no writes at all. Reading it as unset would raise
    // that to the default without a word, and a blank is as likely to mean "none" as "default".
    for (const raw of ["", " ", "\t\n "]) {
      expect(() => parseWriteBudget(raw)).toThrow(WRITE_BUDGET_ENV);
    }
  });

  test.each([
    ["1", 1],
    ["10", 10],
    ["25", 25],
    ["007", 7],
  ])("%s parses to %d — a valid budget above the default is honoured, not clamped", (raw, n) => {
    expect(parseWriteBudget(raw)).toBe(n);
  });

  test("0 is a budget of no writes — not an error, and not the default", () => {
    expect(parseWriteBudget("0")).toBe(0);
  });

  test("surrounding whitespace is trimmed", () => {
    expect(parseWriteBudget(" 5 ")).toBe(5);
    expect(parseWriteBudget("\t5\n")).toBe(5);
  });

  test("the largest budget that still counts down one at a time is accepted", () => {
    expect(MAX_WRITE_BUDGET).toBe(Number.MAX_SAFE_INTEGER);
    expect(parseWriteBudget(String(MAX_WRITE_BUDGET))).toBe(MAX_WRITE_BUDGET);
  });

  // Every one of these went through `Number()` before. NaN and Infinity never ran out; a hex or
  // exponent spelling became a cap nobody wrote; a negative or fractional one ran under a cap
  // nobody wrote either. Each must stop the connector, never be read as some number.
  test.each([
    ["a non-numeric value", "abc"],
    ["a number word", "ten"],
    ["Infinity", "Infinity"],
    ["negative Infinity", "-Infinity"],
    ["NaN", "NaN"],
    ["a negative number", "-1"],
    ["negative zero", "-0"],
    ["an explicit plus sign", "+5"],
    ["a fraction", "1.5"],
    ["a whole number written with a fraction", "10.0"],
    ["exponent notation", "1e3"],
    ["hexadecimal", "0x10"],
    ["a digit separator", "1_000"],
    ["interior whitespace", "1 0"],
    ["an Arabic-Indic five", String.fromCodePoint(0x0665)],
    ["a fullwidth five", String.fromCodePoint(0xff15)],
    ["one past the largest exact budget", "9007199254740992"],
    ["a huge number", "99999999999999999999"],
    ["a number long enough that Number() answers Infinity", "9".repeat(400)],
  ])("%s throws, naming the variable", (_label, raw) => {
    expect(() => parseWriteBudget(raw)).toThrow(WRITE_BUDGET_ENV);
  });

  test("the error quotes the value as written and says what is accepted", () => {
    expect(() => parseWriteBudget(" ten ")).toThrow(
      'NIMBUS_MCP_WRITE_BUDGET=" ten ": expected a whole number of mutations from 0 to ' +
        "9007199254740991, where 0 refuses every write; leave it unset for the default, 10",
    );
  });

  test("the error for an empty value shows it empty and says to unset it for the default", () => {
    expect(() => parseWriteBudget("")).toThrow(
      'NIMBUS_MCP_WRITE_BUDGET="": expected a whole number of mutations from 0 to ' +
        "9007199254740991, where 0 refuses every write; leave it unset for the default, 10",
    );
  });
});

describe("createWriteBudget", () => {
  /**
   * Take until refused, and count the mutations granted. Capped, so a budget that never runs out
   * fails the assertion instead of hanging the suite.
   */
  function granted(budget: WriteBudget): number {
    let n = 0;
    while (n < 100 && budget.take()) n += 1;
    return n;
  }

  test.each([[0], [1], [3], [10]])("a budget of %d grants exactly that many mutations", (limit) => {
    expect(granted(createWriteBudget(limit))).toBe(limit);
  });

  test("hasLeft stays true until the last mutation is taken", () => {
    const budget = createWriteBudget(2);
    expect(budget.hasLeft()).toBe(true);
    expect(budget.take()).toBe(true);
    expect(budget.hasLeft()).toBe(true);
    expect(budget.take()).toBe(true);
    expect(budget.hasLeft()).toBe(false);
  });

  test("a refused take spends nothing and keeps refusing", () => {
    const budget = createWriteBudget(1);
    expect(budget.take()).toBe(true);
    expect(budget.take()).toBe(false);
    expect(budget.take()).toBe(false);
    expect(budget.hasLeft()).toBe(false);
  });

  test("the largest budget the parser accepts is a budget, not a refusal", () => {
    const budget = createWriteBudget(MAX_WRITE_BUDGET);
    expect(budget.take()).toBe(true);
    expect(budget.hasLeft()).toBe(true);
  });

  // `parseWriteBudget` never returns any of these, and the check refuses them anyway. Written as
  // `remaining <= 0` it let a NaN count run forever, and NaN is what an invalid value used to become.
  test.each([
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["a fraction", 1.5],
    ["a fraction below one", 0.5],
    ["negative", -1],
    ["too large to count down exactly", 2 ** 53],
  ])("a count that is %s grants no mutation at all", (_label, limit) => {
    const budget = createWriteBudget(limit);
    expect(budget.hasLeft()).toBe(false);
    expect(granted(budget)).toBe(0);
  });
});
