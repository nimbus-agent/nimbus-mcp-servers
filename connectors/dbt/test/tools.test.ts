import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  type CapturedTools,
  captureTools,
  type FetchStub,
  type StubReply,
  stubFetch,
  withEnv,
} from "../../../scripts/connector-tool-harness.ts";
import { DBT_TOOL_NAMES, registerDbtTools } from "../src/tools.ts";

const API = "https://cloud.getdbt.com/api/v2";

const JOBS = [
  { id: 101, name: "nightly build", dbt_version: "1.8.0" },
  { id: 102, name: "hourly freshness", dbt_version: "1.7.4" },
];

let tools: CapturedTools;
let http: FetchStub | undefined;

function serve(reply: StubReply): FetchStub {
  http?.restore();
  http = stubFetch(reply);
  return http;
}

/** Run `fn` against dbt Cloud's default base with a token. */
function configured(fn: () => Promise<void>): Promise<void> {
  return withEnv({ DBT_TOKEN: "dbt-token", DBT_API_BASE: undefined }, fn);
}

beforeEach(() => {
  tools = captureTools(registerDbtTools);
});

afterEach(() => {
  http?.restore();
  http = undefined;
});

describe("dbt tools", () => {
  it("registers exactly DBT_TOOL_NAMES", () => {
    expect(tools.names()).toEqual([...DBT_TOOL_NAMES]);
  });

  it("list with no account lists accounts, authenticating with the Token scheme", async () => {
    const stub = serve('{"data":[{"id":7}]}');
    await configured(async () => {
      expect(await tools.callJson("dbt_list", {})).toEqual({ data: [{ id: 7 }] });
    });
    expect(stub.only.url).toBe(`${API}/accounts/`);
    expect(stub.only.headers["authorization"]).toBe("Token dbt-token");
  });

  it("list with an account lists its jobs, 100 by default and `limit` when given", async () => {
    const byDefault = serve('{"data":[]}');
    await configured(async () => {
      await tools.call("dbt_list", { accountId: 7 });
    });
    expect(byDefault.only.url).toBe(`${API}/accounts/7/jobs/?limit=100`);

    const limited = serve('{"data":[]}');
    await configured(async () => {
      await tools.call("dbt_list", { accountId: 7, limit: 5 });
    });
    expect(limited.only.url).toBe(`${API}/accounts/7/jobs/?limit=5`);
  });

  it("get fetches one job of one account", async () => {
    const stub = serve('{"data":{"id":101}}');
    await configured(async () => {
      expect(await tools.callJson("dbt_get", { accountId: 7, jobId: 101 })).toEqual({
        data: { id: 101 },
      });
    });
    expect(stub.only.url).toBe(`${API}/accounts/7/jobs/101/`);
  });

  it("talks to a self-hosted base, its trailing slashes stripped", async () => {
    const stub = serve('{"data":[]}');
    await withEnv({ DBT_TOKEN: "t", DBT_API_BASE: "https://dbt.internal.example//" }, async () => {
      await tools.call("dbt_list", {});
    });
    expect(stub.only.url).toBe("https://dbt.internal.example/api/v2/accounts/");
  });

  it("search matches jobs by name, dbt version and id, from an envelope or a bare array", async () => {
    for (const body of [{ data: JOBS }, JOBS]) {
      const stub = serve(JSON.stringify(body));
      const ids = async (query: string): Promise<unknown[]> => {
        let out: unknown;
        await configured(async () => {
          out = await tools.callJson("dbt_search", { accountId: 7, query });
        });
        return (out as { matches: { id: number }[] }).matches.map((m) => m.id);
      };
      expect(await ids("NIGHTLY")).toEqual([101]);
      expect(await ids("1.7")).toEqual([102]);
      expect(await ids("102")).toEqual([102]);
      expect(await ids("weekly")).toEqual([]);
      expect(stub.calls[0]?.url).toBe(`${API}/accounts/7/jobs/?limit=500`);
    }
  });

  it("search finds nothing in an answer that carries no job list", async () => {
    serve('{"status":{"code":200}}');
    await configured(async () => {
      expect(await tools.callJson("dbt_search", { accountId: 7, query: "x" })).toEqual({
        matches: [],
      });
    });
  });

  it("refuses without DBT_TOKEN, before any request, and quotes an API failure", async () => {
    const stub = serve("{}");
    await withEnv({ DBT_TOKEN: undefined }, async () => {
      await expect(tools.call("dbt_list", {})).rejects.toThrow("DBT_TOKEN is not set");
    });
    expect(stub.calls).toEqual([]);

    serve({ status: 404, body: "Not found" });
    await configured(async () => {
      await expect(tools.call("dbt_get", { accountId: 7, jobId: 9 })).rejects.toThrow(
        "dbt Cloud 404: Not found",
      );
    });
  });
});
