import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { resetConnectorModeForTests, setConnectorMode } from "../../../shared/connector-mode.ts";
import type { McpListResult, ZodObjectSchema } from "../../../shared/mcp-tool-kit.ts";
import { registerSnowflakeTools } from "../src/server.ts";

// These cases assert the TOOL SURFACE, not the consent gate. Gateway mode is the shape they were
// written against: the connector registers everything and executor.ts (I2) is the gate. Reset on
// BOTH sides — bun test runs many files in ONE process.
beforeEach(() => {
  resetConnectorModeForTests();
  setConnectorMode("gateway");
});
afterEach(() => {
  resetConnectorModeForTests();
});

/**
 * Minimal server for the consent kit. In gateway mode it never reads the capability surface, but
 * it DOES register through `registerTool` — so this records into the same sink the read registrar
 * fills, or the connector's write tools would vanish from the captured surface.
 */
function consentFakeServer(sink: (name: string, handler: unknown) => void): never {
  return {
    server: { getClientCapabilities: () => undefined },
    registerTool: (name: string, _cfg: unknown, handler: unknown) => {
      sink(name, handler);
      return { disable: () => undefined };
    },
    sendToolListChanged: () => undefined,
    sendLoggingMessage: () => Promise.resolve(),
  } as unknown as never;
}

type Handler = (args: unknown) => Promise<McpListResult>;

/** Capture the registered tool handlers without starting a real stdio transport. */
function captureTools(): Map<string, Handler> {
  const tools = new Map<string, Handler>();
  registerSnowflakeTools(
    <T>(
      name: string,
      _desc: string,
      _schema: ZodObjectSchema<T>,
      handler: (args: T) => Promise<McpListResult>,
    ) => {
      tools.set(name, handler as Handler);
    },
    consentFakeServer((n, h) => tools.set(n, h as Handler)),
  );
  return tools;
}

/** Look up a captured handler, failing loudly if the tool was never registered. */
function tool(tools: Map<string, Handler>, name: string): Handler {
  const handler = tools.get(name);
  if (handler === undefined) {
    throw new Error(`tool not registered: ${name}`);
  }
  return handler;
}

const BS = String.fromCharCode(92);

function parsePayload(res: McpListResult): { items: unknown[]; nextCursor: string | null } {
  return JSON.parse((res.content[0] as { text: string }).text);
}

function names(item: Record<string, unknown> | undefined): string[] {
  return ((item?.["columns"] ?? []) as { name: string }[]).map((c) => c.name);
}

function resp(names: string[], data: unknown[][]): Response {
  return new Response(
    JSON.stringify({ resultSetMetaData: { rowType: names.map((name) => ({ name })) }, data }),
    { status: 200 },
  );
}

const TABLE_COLS = ["DATABASE_NAME", "SCHEMA_NAME", "TABLE_NAME", "ROW_COUNT", "LAST_ALTERED"];
const COLUMN_COLS = [
  "DATABASE_NAME",
  "SCHEMA_NAME",
  "TABLE_NAME",
  "COLUMN_NAME",
  "DATA_TYPE",
  "IS_NULLABLE",
  "ORDINAL_POSITION",
];

describe("snowflake table columns", () => {
  const origFetch = globalThis.fetch;
  let statements: string[] = [];
  let columnRows: unknown[][] = [];
  let failColumns = false;

  beforeEach(() => {
    statements = [];
    columnRows = [];
    failColumns = false;
    process.env["SNOWFLAKE_ACCOUNT"] = "acme-xy12345";
    process.env["SNOWFLAKE_TOKEN"] = "tok";
    globalThis.fetch = (async (_url: string, init: { body: string }) => {
      const statement = JSON.parse(init.body).statement as string;
      statements.push(statement);
      if (statement.includes("information_schema.columns")) {
        if (failColumns) return new Response("denied", { status: 403 });
        return resp(
          COLUMN_COLS,
          columnRows.filter((r) => statement.includes(`table_schema = '${String(r[1])}'`)),
        );
      }
      return resp(TABLE_COLS, [
        ["DB", "PUBLIC", "USERS", "10", "2026-01-01T00:00:00Z"],
        ["DB", "PUBLIC", "ORDERS", "20", "2026-01-01T00:00:00Z"],
        ["DB", "SALES", "LEADS", "30", "2026-01-01T00:00:00Z"],
      ]);
    }) as unknown as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = origFetch;
  });

  it("lists each table's columns with one query per schema, never per table", async () => {
    columnRows = [
      ["DB", "PUBLIC", "USERS", "ID", "NUMBER", "NO", "1"],
      ["DB", "PUBLIC", "USERS", "EMAIL", "TEXT", "YES", "2"],
      ["DB", "PUBLIC", "ORDERS", "ID", "NUMBER", "NO", "1"],
    ];
    const out = parsePayload(await tool(captureTools(), "snowflake_list")({}));
    const colQueries = statements.filter((s) => s.includes("information_schema.columns"));
    expect(colQueries).toHaveLength(2); // PUBLIC and SALES, three tables
    const items = out.items as Record<string, unknown>[];
    expect(items[0]?.["columns"]).toEqual([
      { name: "ID", type: "NUMBER", nullable: false, ordinal: 1 },
      { name: "EMAIL", type: "TEXT", nullable: true, ordinal: 2 },
    ]);
    expect(items[2]?.["columns"]).toEqual([]);
    expect(items[0]?.["columns_complete"]).toBe(true);
  });

  it("selects metadata columns only: no default, comment or row data", async () => {
    await tool(captureTools(), "snowflake_list")({});
    const q = statements.find((s) => s.includes("information_schema.columns")) ?? "";
    expect(q).toContain("column_name, data_type, is_nullable, ordinal_position");
    expect(q).not.toMatch(/column_default|comment|\*/i);
    expect(q).toContain("LIMIT 20001");
    expect(q).toContain("table_schema = 'PUBLIC'");
  });

  it("never copies a value outside the four column fields", async () => {
    columnRows = [["DB", "PUBLIC", "USERS", "ID", "NUMBER", "NO", "1"]];
    const base = globalThis.fetch;
    globalThis.fetch = (async (u: string, init: { body: string }) => {
      const r = await base(u, init);
      const j = JSON.parse(await r.text()) as {
        resultSetMetaData: { rowType: unknown[] };
        data: unknown[][];
      };
      if (JSON.parse(init.body).statement.includes("information_schema.columns")) {
        j.resultSetMetaData.rowType.push({ name: "COLUMN_DEFAULT" }, { name: "SAMPLE" });
        for (const row of j.data) row.push("secret-default", "cell-value");
      }
      return new Response(JSON.stringify(j), { status: 200 });
    }) as unknown as typeof fetch;
    const out = parsePayload(await tool(captureTools(), "snowflake_list")({}));
    expect(JSON.stringify(out)).not.toMatch(/secret-default|cell-value/);
  });

  it("escapes a quote or backslash in a schema name", async () => {
    globalThis.fetch = (async (_u: string, init: { body: string }) => {
      const statement = JSON.parse(init.body).statement as string;
      statements.push(statement);
      if (statement.includes("information_schema.columns")) return resp(COLUMN_COLS, []);
      return resp(TABLE_COLS, [["DB", `A'B${BS}C`, "T", "1", "2026-01-01T00:00:00Z"]]);
    }) as unknown as typeof fetch;
    await tool(captureTools(), "snowflake_list")({});
    const q = statements.find((s) => s.includes("information_schema.columns")) ?? "";
    expect(q).toContain(`table_schema = 'A''B${BS}${BS}C'`);
  });

  it("marks tables incomplete, and still lists them, when the columns query fails", async () => {
    failColumns = true;
    const out = parsePayload(await tool(captureTools(), "snowflake_list")({}));
    const items = out.items as Record<string, unknown>[];
    expect(items).toHaveLength(3);
    expect(items.every((i) => i["columns_complete"] === false)).toBe(true);
  });

  it("marks a schema incomplete when its columns hit the cap", async () => {
    columnRows = Array.from({ length: 20_001 }, (_v, i) => [
      "DB",
      "PUBLIC",
      "USERS",
      `C${String(i)}`,
      "TEXT",
      "YES",
      String(i + 1),
    ]);
    const items = parsePayload(await tool(captureTools(), "snowflake_list")({})).items as Record<
      string,
      unknown
    >[];
    expect(items[0]?.["columns_complete"]).toBe(false);
  });

  it("snowflake_get returns the one table's columns, filtered by table name", async () => {
    columnRows = [["DB", "PUBLIC", "USERS", "ID", "NUMBER", "NO", "1"]];
    const out = JSON.parse(
      (
        (await tool(captureTools(), "snowflake_get")({ id: "db.public.users" })).content[0] as {
          text: string;
        }
      ).text,
    ) as Record<string, unknown>;
    expect(out["columns"]).toEqual([{ name: "ID", type: "NUMBER", nullable: false, ordinal: 1 }]);
    const q = statements.filter((s) => s.includes("information_schema.columns"));
    expect(q).toHaveLength(1);
    expect(q[0]).toContain("table_name = 'USERS'");
  });

  it("marks a schema incomplete when Snowflake reports more than one result partition", async () => {
    const base = globalThis.fetch;
    globalThis.fetch = (async (u: string, init: { body: string }) => {
      const r = await base(u, init);
      const j = JSON.parse(await r.text()) as { resultSetMetaData: Record<string, unknown> };
      if (JSON.parse(init.body).statement.includes("information_schema.columns")) {
        j.resultSetMetaData["partitionInfo"] = [{ rowCount: 1 }, { rowCount: 1 }];
      }
      return new Response(JSON.stringify(j), { status: 200 });
    }) as unknown as typeof fetch;
    const items = parsePayload(await tool(captureTools(), "snowflake_list")({})).items as Record<
      string,
      unknown
    >[];
    expect(items.every((i) => i["columns_complete"] === false)).toBe(true);
  });

  it("keeps USERS and a quoted lower-case users table's columns apart", async () => {
    globalThis.fetch = (async (_u: string, init: { body: string }) => {
      const statement = JSON.parse(init.body).statement as string;
      if (statement.includes("information_schema.columns")) {
        return resp(COLUMN_COLS, [
          ["DB", "PUBLIC", "USERS", "A", "TEXT", "NO", "1"],
          ["DB", "PUBLIC", "users", "B", "TEXT", "NO", "1"],
        ]);
      }
      return resp(TABLE_COLS, [
        ["DB", "PUBLIC", "USERS", "1", "2026-01-01T00:00:00Z"],
        ["DB", "PUBLIC", "users", "1", "2026-01-01T00:00:00Z"],
      ]);
    }) as unknown as typeof fetch;
    const items = parsePayload(await tool(captureTools(), "snowflake_list")({})).items as Record<
      string,
      unknown
    >[];
    expect(names(items[0])).toEqual(["A"]);
    expect(names(items[1])).toEqual(["B"]);
  });
});
