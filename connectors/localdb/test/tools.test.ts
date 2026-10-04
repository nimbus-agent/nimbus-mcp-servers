import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type CapturedTools, captureTools } from "../../../scripts/connector-tool-harness.ts";
import { scanSavedQueries } from "../src/sql-scan.ts";
import { LOCALDB_TOOL_NAMES, registerLocaldbTools } from "../src/tools.ts";

const ACTIVE_USERS = "-- active users\nSELECT id, email\nFROM users\nWHERE active;\n";
const REVENUE = "SELECT sum(amount) FROM invoices;";

type Envelope = Record<string, unknown>;

let dir: string;
let tools: CapturedTools;
const prev = process.env["LOCALDB_SCRIPTS_DIR"];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "nimbus-localdb-tools-"));
  process.env["LOCALDB_SCRIPTS_DIR"] = dir;
  await writeFile(join(dir, "active_users.sql"), ACTIVE_USERS, "utf8");
  await mkdir(join(dir, "finance"));
  await writeFile(join(dir, "finance", "Revenue.SQL"), REVENUE, "utf8");
  tools = captureTools(registerLocaldbTools);
});

afterEach(async () => {
  if (prev === undefined) {
    delete process.env["LOCALDB_SCRIPTS_DIR"];
  } else {
    process.env["LOCALDB_SCRIPTS_DIR"] = prev;
  }
  await rm(dir, { recursive: true, force: true });
});

function byPath(rows: Envelope[]): Envelope[] {
  return [...rows].sort((a, b) =>
    String(a["relativePath"]).localeCompare(String(b["relativePath"])),
  );
}

const ACTIVE_USERS_ENVELOPE = {
  relativePath: "active_users.sql",
  title: "active_users",
  sizeBytes: Buffer.byteLength(ACTIVE_USERS),
  lineCount: 5,
  sql: ACTIVE_USERS,
};

describe("localdb tools", () => {
  it("registers exactly LOCALDB_TOOL_NAMES", () => {
    expect(tools.names()).toEqual([...LOCALDB_TOOL_NAMES]);
  });

  it("list returns every saved query's text and metadata", async () => {
    const out = (await tools.callJson("localdb_list")) as { items: Envelope[] };
    expect(byPath(out.items)).toEqual([
      ACTIVE_USERS_ENVELOPE,
      {
        relativePath: join("finance", "Revenue.SQL"),
        title: "Revenue",
        sizeBytes: Buffer.byteLength(REVENUE),
        lineCount: 1,
        sql: REVENUE,
      },
    ]);
  });

  it("list returns 100 queries by default and honours an explicit limit", async () => {
    await mkdir(join(dir, "bulk"));
    await Promise.all(
      Array.from({ length: 99 }, (_, i) =>
        writeFile(join(dir, "bulk", `q${String(i)}.sql`), "SELECT 1;", "utf8"),
      ),
    );
    // 2 + 99 = 101 saved queries.
    expect(((await tools.callJson("localdb_list")) as { items: Envelope[] }).items).toHaveLength(
      100,
    );
    expect(
      ((await tools.callJson("localdb_list", { limit: 4 })) as { items: Envelope[] }).items,
    ).toHaveLength(4);
  });

  it("get returns one query by relative path, or item: null", async () => {
    expect(await tools.callJson("localdb_get", { relativePath: "active_users.sql" })).toEqual({
      item: ACTIVE_USERS_ENVELOPE,
    });
    expect(await tools.callJson("localdb_get", { relativePath: "missing.sql" })).toEqual({
      item: null,
    });
  });

  it("get refuses a path that escapes the scripts dir", async () => {
    await expect(
      tools.call("localdb_get", { relativePath: join("..", "elsewhere.sql") }),
    ).rejects.toThrow("path escapes the configured local DB scripts dir");
  });

  it("search matches title, path and SQL text, case-insensitively, within the limit", async () => {
    const paths = async (query: string, limit?: number): Promise<unknown[]> => {
      const out = (await tools.callJson("localdb_search", {
        query,
        ...(limit === undefined ? {} : { limit }),
      })) as { matches: Envelope[] };
      return out.matches.map((m) => m["relativePath"]).sort();
    };
    expect(await paths("ACTIVE_users")).toEqual(["active_users.sql"]);
    expect(await paths("finance")).toEqual([join("finance", "Revenue.SQL")]);
    expect(await paths("sum(amount)")).toEqual([join("finance", "Revenue.SQL")]);
    expect(await paths("select")).toHaveLength(2);
    expect(await paths("select", 1)).toHaveLength(1);
    expect(await paths("drop table")).toEqual([]);
  });

  it("every tool refuses when LOCALDB_SCRIPTS_DIR is unset", async () => {
    delete process.env["LOCALDB_SCRIPTS_DIR"];
    for (const [name, args] of [
      ["localdb_list", {}],
      ["localdb_get", { relativePath: "a.sql" }],
      ["localdb_search", { query: "a" }],
    ] as const) {
      await expect(tools.call(name, args)).rejects.toThrow("LOCALDB_SCRIPTS_DIR is not set");
    }
  });
});

describe("scanSavedQueries — size bound", () => {
  it("skips a .sql file over 2 MiB, even one holding valid SQL", async () => {
    // Real SQL padded with whitespace: it would be returned if it were read at all.
    const big = `SELECT 1;${" ".repeat(2 * 1024 * 1024)}`;
    await writeFile(join(dir, "huge.sql"), big, "utf8");
    expect((await scanSavedQueries()).map((q) => q.relativePath).sort()).toEqual([
      "active_users.sql",
      join("finance", "Revenue.SQL"),
    ]);
  });
});
