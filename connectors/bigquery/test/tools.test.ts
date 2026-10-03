import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  type CapturedTools,
  captureTools,
  type FetchStub,
  type RecordedRequest,
  type SpawnStub,
  type StubReply,
  stubFetch,
  stubSpawn,
  withEnv,
} from "../../../scripts/connector-tool-harness.ts";
import { BIGQUERY_TOOL_NAMES, registerBigqueryTools } from "../src/tools.ts";

const BASE = "https://bigquery.googleapis.com/bigquery/v2";

const DATASETS = {
  datasets: [
    { datasetReference: { projectId: "acme", datasetId: "Sales_EU" } },
    { datasetReference: { projectId: "acme", datasetId: "marketing" } },
    // Malformed entries an API change could produce: never a match, never a throw.
    { datasetReference: "sales" },
    "sales",
  ],
};

const TABLES = {
  tables: [
    { tableReference: { datasetId: "sales", tableId: "orders" }, type: "TABLE" },
    {
      tableReference: { datasetId: "sales", tableId: "t_9f2" },
      friendlyName: "Quarterly Revenue",
      type: "VIEW",
    },
    { tableReference: { datasetId: "sales", tableId: "customers" }, type: "TABLE" },
    { tableReference: null, friendlyName: "" },
    42,
  ],
};

let tools: CapturedTools;
let spawn: SpawnStub;
let http: FetchStub | undefined;

function serve(reply: StubReply | ((req: RecordedRequest) => StubReply | undefined)): FetchStub {
  http?.restore();
  http = stubFetch(reply);
  return http;
}

beforeEach(() => {
  spawn = stubSpawn({ stdout: "ya29.test-token\n" });
  tools = captureTools(registerBigqueryTools);
});

afterEach(() => {
  spawn.restore();
  http?.restore();
  http = undefined;
});

/** Run `fn` with BIGQUERY_PROJECT set, as every configured install has it. */
function inProject(fn: () => Promise<void>): Promise<void> {
  return withEnv({ BIGQUERY_PROJECT: "acme-analytics" }, fn);
}

describe("bigquery tools", () => {
  it("registers exactly BIGQUERY_TOOL_NAMES, in order", () => {
    expect(tools.registrationOrder()).toEqual([...BIGQUERY_TOOL_NAMES]);
  });

  it("list with no dataset lists the project's datasets with a gcloud-minted bearer", async () => {
    const stub = serve(JSON.stringify(DATASETS));
    await inProject(async () => {
      expect(await tools.callJson("bigquery_list")).toEqual(DATASETS);
    });
    expect(stub.only.url).toBe(`${BASE}/projects/acme-analytics/datasets?maxResults=200`);
    expect(stub.only.headers["authorization"]).toBe("Bearer ya29.test-token");
    expect(spawn.calls.map((c) => c.command)).toEqual([["gcloud", "auth", "print-access-token"]]);
  });

  it("list with a dataset lists its tables, encoding the path and preferring an explicit project", async () => {
    const stub = serve(JSON.stringify(TABLES));
    await inProject(async () => {
      expect(
        await tools.callJson("bigquery_list", { project: "other proj", dataset: "sales/q3" }),
      ).toEqual(TABLES);
    });
    expect(stub.only.url).toBe(
      `${BASE}/projects/other%20proj/datasets/sales%2Fq3/tables?maxResults=200`,
    );
  });

  it("get fetches one table's metadata", async () => {
    const table = { schema: { fields: [{ name: "id", type: "INT64" }] }, numRows: "12" };
    const stub = serve(JSON.stringify(table));
    await inProject(async () => {
      expect(await tools.callJson("bigquery_get", { dataset: "sales", table: "orders" })).toEqual(
        table,
      );
    });
    expect(stub.only.url).toBe(`${BASE}/projects/acme-analytics/datasets/sales/tables/orders`);
  });

  it("search with no dataset filters dataset ids case-insensitively", async () => {
    const stub = serve(JSON.stringify(DATASETS));
    await inProject(async () => {
      expect(await tools.callJson("bigquery_search", { query: "SALES" })).toEqual({
        matches: [{ datasetReference: { projectId: "acme", datasetId: "Sales_EU" } }],
      });
    });
    expect(stub.only.url).toBe(`${BASE}/projects/acme-analytics/datasets?maxResults=200`);
  });

  it("search with a dataset matches qualified table ids and friendly names", async () => {
    const stub = serve(JSON.stringify(TABLES));
    await inProject(async () => {
      const byId = (await tools.callJson("bigquery_search", {
        dataset: "sales",
        query: "SALES.ORD",
      })) as { matches: unknown[] };
      expect(byId.matches).toEqual([TABLES.tables[0]]);

      const byFriendly = (await tools.callJson("bigquery_search", {
        dataset: "sales",
        query: "revenue",
      })) as { matches: unknown[] };
      expect(byFriendly.matches).toEqual([TABLES.tables[1]]);
    });
    expect(stub.calls.map((c) => c.url)).toEqual([
      `${BASE}/projects/acme-analytics/datasets/sales/tables?maxResults=200`,
      `${BASE}/projects/acme-analytics/datasets/sales/tables?maxResults=200`,
    ]);
  });

  it("search finds nothing in a response that carries no array", async () => {
    serve(JSON.stringify({ kind: "bigquery#tableList" }));
    await inProject(async () => {
      expect(await tools.callJson("bigquery_search", { dataset: "sales", query: "x" })).toEqual({
        matches: [],
      });
    });
  });

  it("surfaces a non-2xx response with its status and body", async () => {
    serve({ status: 403, body: "Access Denied: Project acme-analytics" });
    await inProject(async () => {
      await expect(tools.call("bigquery_list")).rejects.toThrow(
        "BigQuery 403: Access Denied: Project acme-analytics",
      );
    });
  });

  it("refuses with gcloud's stderr when the token cannot be minted, before any request", async () => {
    spawn.restore();
    spawn = stubSpawn({
      exitCode: 1,
      stdout: "",
      stderr: "You do not currently have an active account",
    });
    const stub = serve("{}");
    await inProject(async () => {
      await expect(tools.call("bigquery_list")).rejects.toThrow(
        "gcloud auth print-access-token failed: You do not currently have an active account",
      );
    });
    expect(stub.calls).toEqual([]);
  });

  it("treats a zero-exit gcloud that printed no token as a failure", async () => {
    spawn.restore();
    spawn = stubSpawn({ exitCode: 0, stdout: "  \n", stderr: "" });
    const stub = serve("{}");
    await inProject(async () => {
      await expect(tools.call("bigquery_list")).rejects.toThrow(
        "gcloud auth print-access-token failed",
      );
    });
    expect(stub.calls).toEqual([]);
  });

  it("refuses without a project from either the argument or BIGQUERY_PROJECT", async () => {
    const stub = serve("{}");
    for (const value of [undefined, "   "]) {
      await withEnv({ BIGQUERY_PROJECT: value }, async () => {
        await expect(tools.call("bigquery_get", { dataset: "d", table: "t" })).rejects.toThrow(
          "BIGQUERY_PROJECT is not set and no project argument was provided",
        );
      });
    }
    expect(stub.calls).toEqual([]);
  });

  it("hands gcloud the trimmed GOOGLE_APPLICATION_CREDENTIALS key path", async () => {
    serve(JSON.stringify(DATASETS));
    await withEnv(
      { BIGQUERY_PROJECT: "acme-analytics", GOOGLE_APPLICATION_CREDENTIALS: "  /keys/sa.json \n" },
      async () => {
        await tools.call("bigquery_list");
      },
    );
    expect(spawn.calls[0]?.env["GOOGLE_APPLICATION_CREDENTIALS"]).toBe("/keys/sa.json");
  });
});
