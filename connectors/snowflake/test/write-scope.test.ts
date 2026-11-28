import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  approvedStandaloneWrite,
  type FetchStub,
  stubFetch,
  withEnv,
} from "../../../scripts/connector-tool-harness.ts";
import { resetConnectorModeForTests, setConnectorMode } from "../../../shared/connector-mode.ts";
import { registerSnowflakeTools } from "../src/server.ts";

let http: FetchStub | undefined;

beforeEach(() => {
  resetConnectorModeForTests();
  setConnectorMode("standalone");
  http = stubFetch('{"statementHandle":"h1"}');
});
afterEach(() => {
  http?.restore();
  resetConnectorModeForTests();
});

/** Run snowflake_comment_set on `object` under a scope of exactly `term`. */
async function commentUnder(term: string, object: string) {
  let run: Awaited<ReturnType<typeof approvedStandaloneWrite>> | undefined;
  await withEnv({ SNOWFLAKE_ACCOUNT: "acme-xy12345", SNOWFLAKE_TOKEN: "tok" }, async () => {
    run = await approvedStandaloneWrite(
      registerSnowflakeTools,
      { NIMBUS_MCP_SNOWFLAKE_WRITE_SCOPE: term },
      "snowflake_comment_set",
      { object, comment: "c" },
    );
  });
  if (run === undefined) throw new Error("no run");
  return run;
}

const isRefused = (answer: unknown) => (answer as { ok?: boolean }).ok === false;

describe("snowflake write scope normalises the object identifier", () => {
  for (const spelling of ["db.sch.t", "DB.SCH.T", '"DB"."SCH"."T"', 'db."SCH".t']) {
    it(`${spelling} matches object:DB.SCH.T`, async () => {
      const run = await commentUnder("object:DB.SCH.T", spelling);
      expect(isRefused(run.answer)).toBe(false);
      expect(run.audit.map((e) => e.outcome)).toEqual(["requested", "accepted", "executed"]);
    });
  }

  it("a quoted mixed-case part keeps its case", async () => {
    const ok = await commentUnder("object:DB.SCH.MyTable", 'db.sch."MyTable"');
    expect(isRefused(ok.answer)).toBe(false);
    const upper = await commentUnder("object:DB.SCH.MYTABLE", 'db.sch."MyTable"');
    expect(isRefused(upper.answer)).toBe(true);
  });

  it("a lower-case scope term no longer matches", async () => {
    const run = await commentUnder("object:db.sch.t", "db.sch.t");
    expect(isRefused(run.answer)).toBe(true);
  });

  it("an unparseable value is matched verbatim", async () => {
    const refused = await commentUnder("object:DB.SCH.T", 'db.sch."T');
    expect(isRefused(refused.answer)).toBe(true);
    expect(refused.audit.at(-1)?.detail["target"]).toEqual({ kind: "object", value: 'db.sch."T' });
  });
});
