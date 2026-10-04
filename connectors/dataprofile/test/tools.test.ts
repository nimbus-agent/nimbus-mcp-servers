import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type CapturedTools, captureTools } from "../../../scripts/connector-tool-harness.ts";
import { DATAPROFILE_TOOL_NAMES, registerDataprofileTools } from "../src/tools.ts";

/** A cell value that must never appear in any tool result. */
const PII = "alice@example.com";

type Envelope = {
  relativePath: string;
  format: string;
  columns: { name: string; type: string | null }[];
  columnCount: number;
  rowCountEstimate: number | null;
  sizeBytes: number;
};

let dir: string;
let tools: CapturedTools;
const prev = process.env["DATAPROFILE_DIR"];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "nimbus-dp-tools-"));
  process.env["DATAPROFILE_DIR"] = dir;
  await writeFile(join(dir, "customers.csv"), `id,email\n1,${PII}\n2,bob@example.com\n`, "utf8");
  await writeFile(join(dir, "events.jsonl"), '{"ts":1,"kind":"click"}\n{"ts":2,"kind":"view"}\n');
  tools = captureTools(registerDataprofileTools);
});

afterEach(async () => {
  if (prev === undefined) {
    delete process.env["DATAPROFILE_DIR"];
  } else {
    process.env["DATAPROFILE_DIR"] = prev;
  }
  await rm(dir, { recursive: true, force: true });
});

function byPath(rows: Envelope[]): Envelope[] {
  return [...rows].sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}

const CUSTOMERS: Envelope = {
  relativePath: "customers.csv",
  format: "csv",
  columns: [
    { name: "id", type: null },
    { name: "email", type: null },
  ],
  columnCount: 2,
  rowCountEstimate: 2,
  sizeBytes: Buffer.byteLength(`id,email\n1,${PII}\n2,bob@example.com\n`),
};

describe("dataprofile tools", () => {
  it("registers exactly DATAPROFILE_TOOL_NAMES, in order", () => {
    expect(tools.registrationOrder()).toEqual([...DATAPROFILE_TOOL_NAMES]);
  });

  it("list returns every data file's schema-only envelope and never a cell value", async () => {
    const out = (await tools.callJson("dataprofile_list")) as { items: Envelope[] };
    expect(byPath(out.items)).toEqual([
      CUSTOMERS,
      {
        relativePath: "events.jsonl",
        format: "jsonl",
        columns: [
          { name: "ts", type: "number" },
          { name: "kind", type: "string" },
        ],
        columnCount: 2,
        rowCountEstimate: 2,
        sizeBytes: Buffer.byteLength('{"ts":1,"kind":"click"}\n{"ts":2,"kind":"view"}\n'),
      },
    ]);
    const text = JSON.stringify(out);
    expect(text).not.toContain(PII);
    expect(text).not.toContain("click");
  });

  it("list caps at 200 by default and honours an explicit limit", async () => {
    await mkdir(join(dir, "many"));
    await Promise.all(
      Array.from({ length: 199 }, (_, i) =>
        writeFile(join(dir, "many", `t${String(i)}.csv`), "c\n1\n", "utf8"),
      ),
    );
    // 2 top-level files + 199 = 201 data files.
    const all = (await tools.callJson("dataprofile_list")) as { items: Envelope[] };
    expect(all.items).toHaveLength(200);
    const three = (await tools.callJson("dataprofile_list", { limit: 3 })) as { items: Envelope[] };
    expect(three.items).toHaveLength(3);
  });

  it("get profiles one file by relative path", async () => {
    expect(await tools.callJson("dataprofile_get", { relativePath: "customers.csv" })).toEqual({
      item: CUSTOMERS,
    });
  });

  it("get answers item: null for a missing or non-data file", async () => {
    await writeFile(join(dir, "notes.txt"), "not data", "utf8");
    expect(await tools.callJson("dataprofile_get", { relativePath: "nope.csv" })).toEqual({
      item: null,
    });
    expect(await tools.callJson("dataprofile_get", { relativePath: "notes.txt" })).toEqual({
      item: null,
    });
  });

  it("get refuses a path that escapes the configured dir", async () => {
    await expect(
      tools.call("dataprofile_get", { relativePath: join("..", "outside.csv") }),
    ).rejects.toThrow("the configured data-profile dir");
  });

  it("search matches a column name, a format and a path", async () => {
    const byColumn = (await tools.callJson("dataprofile_search", { query: "EMAIL" })) as {
      matches: Envelope[];
    };
    expect(byColumn.matches.map((m) => m.relativePath)).toEqual(["customers.csv"]);

    const byFormat = (await tools.callJson("dataprofile_search", { query: "jsonl" })) as {
      matches: Envelope[];
    };
    expect(byFormat.matches.map((m) => m.relativePath)).toEqual(["events.jsonl"]);

    const none = (await tools.callJson("dataprofile_search", { query: "invoices" })) as {
      matches: Envelope[];
    };
    expect(none.matches).toEqual([]);
  });

  it("search honours its limit", async () => {
    const limited = (await tools.callJson("dataprofile_search", { query: "s", limit: 1 })) as {
      matches: Envelope[];
    };
    expect(limited.matches).toHaveLength(1);
  });

  it("every tool refuses when DATAPROFILE_DIR is unset", async () => {
    delete process.env["DATAPROFILE_DIR"];
    for (const [name, args] of [
      ["dataprofile_list", {}],
      ["dataprofile_get", { relativePath: "customers.csv" }],
      ["dataprofile_search", { query: "id" }],
    ] as const) {
      await expect(tools.call(name, args)).rejects.toThrow("DATAPROFILE_DIR is not set");
    }
  });
});
