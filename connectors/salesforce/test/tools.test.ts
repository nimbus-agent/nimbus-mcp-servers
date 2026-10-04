import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  byToolName,
  type CapturedTools,
  captureTools,
  type FetchStub,
  type StubReply,
  stubFetch,
  withEnv,
} from "../../../scripts/connector-tool-harness.ts";
import { registerSalesforceTools, SALESFORCE_TOOL_NAMES } from "../src/tools.ts";

const INSTANCE = "https://acme.my.salesforce.com";
const DATA = `${INSTANCE}/services/data/v60.0`;

/** The SOQL list query for `limit` rows, decoded. */
function soql(limit: number): string {
  return (
    "SELECT Id, Name, StageName, Amount, CloseDate, Probability, Type, IsClosed, IsWon, " +
    `LastModifiedDate, CreatedDate FROM Opportunity ORDER BY LastModifiedDate DESC LIMIT ${String(limit)}`
  );
}

/** The `q` a request sent, decoded. */
function queryOf(url: string): string | null {
  return new URL(url).searchParams.get("q");
}

const OPPORTUNITIES = {
  totalSize: 2,
  done: true,
  records: [
    { Id: "006A", Name: "Acme renewal", StageName: "Closed Won", Type: "Existing Business" },
    { Id: "006B", Name: "Globex pilot", StageName: "Prospecting", Type: "New Business" },
  ],
};

let tools: CapturedTools;
let http: FetchStub | undefined;

function serve(reply: StubReply): FetchStub {
  http?.restore();
  http = stubFetch(reply);
  return http;
}

function configured(fn: () => Promise<void>): Promise<void> {
  return withEnv(
    { SALESFORCE_INSTANCE_URL: `${INSTANCE}/`, SALESFORCE_ACCESS_TOKEN: "00D!token" },
    fn,
  );
}

beforeEach(() => {
  tools = captureTools(registerSalesforceTools);
});

afterEach(() => {
  http?.restore();
  http = undefined;
});

describe("salesforce tools", () => {
  it("registers exactly SALESFORCE_TOOL_NAMES", () => {
    expect(tools.names()).toEqual([...SALESFORCE_TOOL_NAMES].sort(byToolName));
  });

  it("list runs the opportunity SOQL for 200 rows by default and `limit` when given", async () => {
    const stub = serve(JSON.stringify(OPPORTUNITIES));
    await configured(async () => {
      expect(await tools.callJson("salesforce_list", {})).toEqual(OPPORTUNITIES);
      await tools.call("salesforce_list", { limit: 5 });
    });
    expect(stub.calls.map((c) => c.url.split("?")[0])).toEqual([`${DATA}/query`, `${DATA}/query`]);
    expect(stub.calls.map((c) => queryOf(c.url))).toEqual([soql(200), soql(5)]);
    expect(stub.calls[0]?.headers["authorization"]).toBe("Bearer 00D!token");
  });

  it("get fetches one opportunity sobject by its encoded id", async () => {
    const stub = serve('{"Id":"006A"}');
    await configured(async () => {
      expect(await tools.callJson("salesforce_get", { id: "006A/x" })).toEqual({ Id: "006A" });
    });
    expect(stub.only.url).toBe(`${DATA}/sobjects/Opportunity/006A%2Fx`);
  });

  it("search matches name, stage and type over the first 2000 opportunities", async () => {
    const stub = serve(JSON.stringify(OPPORTUNITIES));
    const ids = async (query: string): Promise<unknown[]> => {
      let out: unknown;
      await configured(async () => {
        out = await tools.callJson("salesforce_search", { query });
      });
      return (out as { matches: { Id: string }[] }).matches.map((m) => m.Id);
    };
    expect(await ids("acme")).toEqual(["006A"]);
    expect(await ids("PROSPECTING")).toEqual(["006B"]);
    expect(await ids("new business")).toEqual(["006B"]);
    expect(await ids("initech")).toEqual([]);
    expect(queryOf(stub.calls[0]?.url ?? "")).toBe(soql(2000));
  });

  it("search finds nothing in an answer that carries no `records` array", async () => {
    serve('[{"errorCode":"INVALID_SESSION_ID"}]');
    await configured(async () => {
      expect(await tools.callJson("salesforce_search", { query: "acme" })).toEqual({
        matches: [],
      });
    });
  });

  it("refuses without an access token, before any request, and quotes an API failure", async () => {
    const stub = serve("{}");
    await withEnv(
      { SALESFORCE_INSTANCE_URL: INSTANCE, SALESFORCE_ACCESS_TOKEN: undefined },
      async () => {
        await expect(tools.call("salesforce_list", {})).rejects.toThrow(
          "SALESFORCE_ACCESS_TOKEN is not set",
        );
      },
    );
    expect(stub.calls).toEqual([]);

    serve({ status: 404, body: "NOT_FOUND" });
    await configured(async () => {
      await expect(tools.call("salesforce_get", { id: "006Z" })).rejects.toThrow(
        "Salesforce 404: NOT_FOUND",
      );
    });
  });
});
