import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  type CapturedTools,
  captureTools,
  type FetchStub,
  type RecordedRequest,
  stubFetch,
  withEnv,
} from "../../../scripts/connector-tool-harness.ts";
import { resetConnectorModeForTests, setConnectorMode } from "../../../shared/connector-mode.ts";
import { registerSnowflakeTools } from "../src/server.ts";

const ENV = { SNOWFLAKE_ACCOUNT: "acme-xy12345", SNOWFLAKE_TOKEN: "sf-test-value" };
let tools: CapturedTools;
let http: FetchStub | undefined;

beforeEach(() => {
  resetConnectorModeForTests();
  setConnectorMode("gateway");
  tools = captureTools(registerSnowflakeTools);
});
afterEach(() => {
  http?.restore();
  http = undefined;
  resetConnectorModeForTests();
});

/** A statements reply with the given column names (any case) and rows. */
function rows(columns: string[], data: (string | null)[][]): string {
  return JSON.stringify({
    resultSetMetaData: { rowType: columns.map((name) => ({ name })) },
    data,
  });
}

const SHOW = (name: string, comment: string): string =>
  rows(["created_on", "name", "comment"], [["2026-01-01", name, comment]]);
const TAGS = rows(
  ["TAG_NAME", "TAG_VALUE"],
  [
    ["PII", "yes"],
    ["COST_CENTER", "42"],
  ],
);

function statements(stub: FetchStub): string[] {
  return stub.calls.map(
    (c: RecordedRequest) => (JSON.parse(c.body ?? "{}") as { statement: string }).statement,
  );
}

function serve(reply: Parameters<typeof stubFetch>[0]): FetchStub {
  http?.restore();
  http = stubFetch(reply);
  return http;
}

async function call(args: Record<string, unknown>): Promise<unknown> {
  return withEnv(ENV, () => tools.callJson("snowflake_object_metadata_get", args));
}

describe("snowflake_object_metadata_get", () => {
  it("reads the comment and the tags with two live statements, tags sorted", async () => {
    const stub = serve((req) =>
      req.body?.includes("SHOW") ? SHOW("ORDERS", "Order facts") : TAGS,
    );
    expect(await call({ object: "SALES.PUBLIC.ORDERS" })).toEqual({
      object: "SALES.PUBLIC.ORDERS",
      objectType: "table",
      comment: "Order facts",
      tags: [
        { name: "COST_CENTER", value: "42" },
        { name: "PII", value: "yes" },
      ],
    });
    expect(statements(stub)).toEqual([
      "SHOW TABLES LIKE 'ORDERS' IN SCHEMA SALES.PUBLIC",
      "SELECT tag_name, tag_value FROM TABLE(SALES.INFORMATION_SCHEMA.TAG_REFERENCES('SALES.PUBLIC.ORDERS', 'TABLE'))",
    ]);
    // Never the lagging view.
    expect(statements(stub).join(" ")).not.toMatch(/ACCOUNT_USAGE/i);
  });

  it("a view uses SHOW VIEWS and still the TABLE domain", async () => {
    const stub = serve((req) => (req.body?.includes("SHOW") ? SHOW("V1", "") : TAGS));
    const out = (await call({ objectType: "view", object: "db.sch.v1" })) as { objectType: string };
    expect(out.objectType).toBe("view");
    expect(statements(stub)[0]).toBe("SHOW VIEWS LIKE 'v1' IN SCHEMA db.sch");
    expect(statements(stub)[1]).toContain("TAG_REFERENCES('db.sch.v1', 'TABLE')");
  });

  it("LIKE wildcards only narrow: a different object the pattern also matches is not returned", async () => {
    // `my_table` as a pattern also matches MYXTABLE; the exact name is picked in code.
    serve((req) =>
      req.body?.includes("SHOW")
        ? rows(
            ["name", "comment"],
            [
              ["MYXTABLE", "other"],
              ["MY_TABLE", "mine"],
            ],
          )
        : TAGS,
    );
    expect(((await call({ object: "d.s.my_table" })) as { comment: string }).comment).toBe("mine");
    serve(rows(["name", "comment"], [["MYXTABLE", "other"]]));
    await expect(call({ object: "d.s.my_table" })).rejects.toThrow("Snowflake table not found");
  });

  it("an object that is not shown is 'not found' and no tag statement is sent", async () => {
    const stub = serve(rows(["name", "comment"], []));
    await expect(call({ object: "d.s.gone" })).rejects.toThrow(
      "Snowflake table not found: d.s.gone",
    );
    expect(statements(stub)).toHaveLength(1);
  });

  it("a quoted part keeps its case and a single quote in the pattern is doubled", async () => {
    const stub = serve((req) => (req.body?.includes("SHOW") ? SHOW("o'Mixed", "c") : TAGS));
    await call({ object: 'd.s."o\'Mixed"' });
    expect(statements(stub)[0]).toBe("SHOW TABLES LIKE 'o''Mixed' IN SCHEMA d.s");
  });

  it("refuses an unsafe, unqualified or backslashed name before any request", async () => {
    const stub = serve("{}");
    for (const object of ["d.s.x; DROP TABLE y", "onlyname", "a.b", 'd.s."a\\b"', "a.b.c.d"]) {
      await expect(call({ object })).rejects.toThrow();
    }
    expect(stub.calls).toEqual([]);
  });

  it("refuses without SNOWFLAKE_TOKEN, before any request", async () => {
    const stub = serve("{}");
    await withEnv({ SNOWFLAKE_ACCOUNT: "a", SNOWFLAKE_TOKEN: undefined }, async () => {
      await expect(
        tools.call("snowflake_object_metadata_get", { object: "d.s.t" }),
      ).rejects.toThrow();
    });
    expect(stub.calls).toEqual([]);
  });

  it("a cross-origin 302 is refused and the token goes nowhere else", async () => {
    const stub = serve({
      status: 302,
      headers: { Location: "https://evil.example/x" },
    });
    await expect(call({ object: "d.s.t" })).rejects.toThrow(
      /answered a POST with a redirect \(302\)/,
    );
    expect(stub.calls).toHaveLength(1);
    expect(stub.calls.some((c) => new URL(c.url).host === "evil.example")).toBe(false);
  });
});
