import { describe, expect, test } from "bun:test";

import {
  DEFAULT_WRITE_BUDGET,
  MAX_WRITE_BUDGET,
  parseWriteBudget,
  WRITE_BUDGET_ENV,
} from "./write-budget.ts";

describe("parseWriteBudget", () => {
  test("an unset budget is the documented default of 10", () => {
    expect(parseWriteBudget(undefined)).toBe(DEFAULT_WRITE_BUDGET);
    expect(DEFAULT_WRITE_BUDGET).toBe(10);
  });

  test("empty and whitespace-only read as unset, as every other variable here reads them", () => {
    for (const raw of ["", " ", "\t\n "]) {
      expect(parseWriteBudget(raw)).toBe(DEFAULT_WRITE_BUDGET);
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
        "9007199254740991, where 0 refuses every write; unset or empty means the default, 10",
    );
  });
});
