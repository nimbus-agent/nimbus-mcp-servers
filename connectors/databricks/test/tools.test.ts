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
import { DATABRICKS_TOOL_NAMES, registerDatabricksTools } from "../src/tools.ts";

const HOST = "https://dbc-1234.cloud.databricks.com";

const JOBS = {
  jobs: [
    { job_id: 11, creator_user_name: "ada@example.com", settings: { name: "Nightly ETL" } },
    // A job_id that is not a finite number is not matched as one.
    { job_id: "22", creator_user_name: "bob@example.com", settings: { name: "Backfill" } },
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
  return withEnv({ DATABRICKS_HOST: `${HOST}/`, DATABRICKS_TOKEN: "dapi-token" }, fn);
}

beforeEach(() => {
  tools = captureTools(registerDatabricksTools);
});

afterEach(() => {
  http?.restore();
  http = undefined;
});

describe("databricks tools", () => {
  it("registers exactly DATABRICKS_TOOL_NAMES", () => {
    expect(tools.names()).toEqual([...DATABRICKS_TOOL_NAMES].sort(byToolName));
  });

  it("list asks for 25 jobs by default and `limit` when given, with a bearer token", async () => {
    const stub = serve(JSON.stringify(JOBS));
    await configured(async () => {
      expect(await tools.callJson("databricks_list", {})).toEqual(JOBS);
      await tools.call("databricks_list", { limit: 3 });
    });
    expect(stub.calls.map((c) => c.url)).toEqual([
      `${HOST}/api/2.1/jobs/list?limit=25`,
      `${HOST}/api/2.1/jobs/list?limit=3`,
    ]);
    expect(stub.calls[0]?.headers["authorization"]).toBe("Bearer dapi-token");
  });

  it("get fetches one job by its numeric id", async () => {
    const stub = serve('{"job_id":11}');
    await configured(async () => {
      expect(await tools.callJson("databricks_get", { jobId: 11 })).toEqual({ job_id: 11 });
    });
    expect(stub.only.url).toBe(`${HOST}/api/2.1/jobs/get?job_id=11`);
  });

  it("search matches job name, creator and numeric job id across 100 jobs", async () => {
    const stub = serve(JSON.stringify(JOBS));
    const names = async (query: string): Promise<unknown[]> => {
      let out: unknown;
      await configured(async () => {
        out = await tools.callJson("databricks_search", { query });
      });
      return (out as { matches: { settings: { name: string } }[] }).matches.map(
        (m) => m.settings.name,
      );
    };
    expect(await names("nightly")).toEqual(["Nightly ETL"]);
    expect(await names("BOB@")).toEqual(["Backfill"]);
    expect(await names("11")).toEqual(["Nightly ETL"]);
    expect(await names("22")).toEqual([]);
    expect(stub.calls[0]?.url).toBe(`${HOST}/api/2.1/jobs/list?limit=100`);
  });

  it("search finds nothing in an answer that carries no `jobs` array", async () => {
    serve('{"has_more":false}');
    await configured(async () => {
      expect(await tools.callJson("databricks_search", { query: "etl" })).toEqual({
        matches: [],
      });
    });
  });

  it("refuses without DATABRICKS_HOST, before any request, and quotes an API failure", async () => {
    const stub = serve("{}");
    await withEnv({ DATABRICKS_HOST: undefined, DATABRICKS_TOKEN: "t" }, async () => {
      await expect(tools.call("databricks_list", {})).rejects.toThrow("DATABRICKS_HOST is not set");
    });
    expect(stub.calls).toEqual([]);

    serve({ status: 400, body: "Job 9 does not exist." });
    await configured(async () => {
      await expect(tools.call("databricks_get", { jobId: 9 })).rejects.toThrow(
        "Databricks 400: Job 9 does not exist.",
      );
    });
  });
});
