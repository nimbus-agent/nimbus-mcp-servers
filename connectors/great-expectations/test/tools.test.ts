import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type CapturedTools, captureTools } from "../../../scripts/connector-tool-harness.ts";
import { GREAT_EXPECTATIONS_TOOL_NAMES, registerGreatExpectationsTools } from "../src/tools.ts";

const PII = "secret-pii@example.com";

/** The exact metadata envelope every tool returns per expectation — nothing more. */
const ENVELOPE_KEYS = [
  "batchId",
  "column",
  "elementCount",
  "expectationType",
  "externalId",
  "observedValue",
  "runId",
  "runTime",
  "sourceFile",
  "success",
  "successPercent",
  "suiteName",
  "unexpectedCount",
  "unexpectedPercent",
];

const ORDERS = {
  meta: {
    expectation_suite_name: "orders.critical",
    batch_id: "orders-2026-10-01",
    run_id: { run_name: "nightly", run_time: "2026-10-01T02:00:00Z" },
  },
  statistics: { success_percent: 50 },
  results: [
    {
      success: true,
      expectation_config: {
        expectation_type: "expect_column_values_to_not_be_null",
        kwargs: { column: "order_id" },
      },
      result: { element_count: 120, unexpected_count: 0, unexpected_percent: 0 },
    },
    {
      success: false,
      expectation_config: {
        expectation_type: "expect_column_values_to_be_unique",
        kwargs: { column: "email" },
      },
      result: {
        element_count: 120,
        unexpected_count: 2,
        unexpected_percent: 1.5,
        unexpected_list: [PII, PII],
        partial_unexpected_list: [PII],
      },
    },
  ],
};

const CUSTOMERS = {
  meta: { expectation_suite_name: "customers.warning", batch_id: "customers" },
  results: [
    {
      success: true,
      expectation_config: { expectation_type: "expect_table_row_count_to_be_between", kwargs: {} },
      result: { observed_value: 5000 },
    },
  ],
};

const UNIQUE_EMAIL_ID =
  "orders.critical::orders-2026-10-01::expect_column_values_to_be_unique::email";

type Envelope = Record<string, unknown>;

let dir: string;
let tools: CapturedTools;
const prevEnv = process.env["GREAT_EXPECTATIONS_RESULTS_DIR"];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "gx-tools-"));
  process.env["GREAT_EXPECTATIONS_RESULTS_DIR"] = dir;
  await writeFile(join(dir, "orders.json"), JSON.stringify(ORDERS), "utf8");
  await writeFile(join(dir, "customers.json"), JSON.stringify(CUSTOMERS), "utf8");
  tools = captureTools(registerGreatExpectationsTools);
});

afterEach(async () => {
  if (prevEnv === undefined) {
    delete process.env["GREAT_EXPECTATIONS_RESULTS_DIR"];
  } else {
    process.env["GREAT_EXPECTATIONS_RESULTS_DIR"] = prevEnv;
  }
  await rm(dir, { recursive: true, force: true });
});

function ids(rows: unknown): string[] {
  return (rows as Envelope[])
    .map((r) => String(r["externalId"]))
    .sort((a, b) => a.localeCompare(b));
}

describe("great_expectations tools", () => {
  it("registers exactly GREAT_EXPECTATIONS_TOOL_NAMES, in order", () => {
    expect(tools.registrationOrder()).toEqual([...GREAT_EXPECTATIONS_TOOL_NAMES]);
  });

  it("list returns every expectation as a metadata-only envelope", async () => {
    const out = (await tools.callJson("great_expectations_list")) as { results: Envelope[] };
    expect(ids(out.results)).toEqual([
      "customers.warning::customers::expect_table_row_count_to_be_between::_",
      "orders.critical::orders-2026-10-01::expect_column_values_to_be_unique::email",
      "orders.critical::orders-2026-10-01::expect_column_values_to_not_be_null::order_id",
    ]);
    for (const row of out.results) {
      expect(Object.keys(row).sort((a, b) => a.localeCompare(b))).toEqual(ENVELOPE_KEYS);
    }
    const text = JSON.stringify(out);
    expect(text).not.toContain(PII);
    expect(text).not.toContain("unexpected_list");
  });

  it("list returns 100 entries by default and honours an explicit limit", async () => {
    const many = {
      meta: { expectation_suite_name: "wide", batch_id: "b" },
      results: Array.from({ length: 105 }, (_, i) => ({
        success: true,
        expectation_config: { expectation_type: `expect_${String(i)}`, kwargs: {} },
        result: {},
      })),
    };
    await rm(join(dir, "orders.json"));
    await rm(join(dir, "customers.json"));
    await writeFile(join(dir, "wide.json"), JSON.stringify(many), "utf8");

    const all = (await tools.callJson("great_expectations_list")) as { results: Envelope[] };
    expect(all.results).toHaveLength(100);
    expect(all.results[0]?.["expectationType"]).toBe("expect_0");
    expect(all.results[99]?.["expectationType"]).toBe("expect_99");

    const two = (await tools.callJson("great_expectations_list", { limit: 2 })) as {
      results: Envelope[];
    };
    expect(two.results.map((r) => r["expectationType"])).toEqual(["expect_0", "expect_1"]);
  });

  it("get returns the one matching expectation's metadata", async () => {
    const out = (await tools.callJson("great_expectations_get", {
      externalId: UNIQUE_EMAIL_ID,
    })) as { match: Envelope };
    expect(out.match).toEqual({
      externalId: UNIQUE_EMAIL_ID,
      suiteName: "orders.critical",
      batchId: "orders-2026-10-01",
      runId: "nightly",
      runTime: "2026-10-01T02:00:00Z",
      expectationType: "expect_column_values_to_be_unique",
      column: "email",
      success: false,
      observedValue: null,
      elementCount: 120,
      unexpectedCount: 2,
      unexpectedPercent: 1.5,
      successPercent: 50,
      sourceFile: "orders.json",
    });
  });

  it("get answers match: null for an id it does not hold", async () => {
    expect(
      await tools.callJson("great_expectations_get", { externalId: "orders.critical::nope" }),
    ).toEqual({ match: null });
  });

  it("search matches suite name, expectation type and column, case-insensitively", async () => {
    const bySuite = (await tools.callJson("great_expectations_search", {
      query: "ORDERS.CRITICAL",
    })) as { matches: Envelope[] };
    expect(bySuite.matches).toHaveLength(2);

    const byType = (await tools.callJson("great_expectations_search", {
      query: "Row_Count",
    })) as { matches: Envelope[] };
    expect(ids(byType.matches)).toEqual([
      "customers.warning::customers::expect_table_row_count_to_be_between::_",
    ]);

    const byColumn = (await tools.callJson("great_expectations_search", {
      query: "EMAIL",
    })) as { matches: Envelope[] };
    expect(ids(byColumn.matches)).toEqual([UNIQUE_EMAIL_ID]);
  });

  it("search returns no matches for a query nothing contains, and honours limit", async () => {
    expect(await tools.callJson("great_expectations_search", { query: "invoices" })).toEqual({
      matches: [],
    });
    const limited = (await tools.callJson("great_expectations_search", {
      query: "expect_",
      limit: 1,
    })) as { matches: Envelope[] };
    expect(limited.matches).toHaveLength(1);
  });

  it("every tool refuses when GREAT_EXPECTATIONS_RESULTS_DIR is unset", async () => {
    delete process.env["GREAT_EXPECTATIONS_RESULTS_DIR"];
    for (const [name, args] of [
      ["great_expectations_list", {}],
      ["great_expectations_get", { externalId: UNIQUE_EMAIL_ID }],
      ["great_expectations_search", { query: "orders" }],
    ] as const) {
      await expect(tools.call(name, args)).rejects.toThrow(
        "GREAT_EXPECTATIONS_RESULTS_DIR is not set",
      );
    }
  });

  it("rejects a limit outside 1..500 at the schema", async () => {
    await expect(tools.call("great_expectations_list", { limit: 0 })).rejects.toThrow(
      "Too small: expected number to be >=1",
    );
    await expect(
      tools.call("great_expectations_search", { query: "x", limit: 501 }),
    ).rejects.toThrow("Too big: expected number to be <=500");
  });
});
