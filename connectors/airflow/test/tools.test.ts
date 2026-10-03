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
import { AIRFLOW_TOOL_NAMES, registerAirflowTools } from "../src/tools.ts";

const DAGS = {
  dags: [
    {
      dag_id: "etl_orders",
      description: "Load orders",
      owners: ["data"],
      tags: [{ name: "prod" }],
    },
    { dag_id: "refresh_cache", description: null, owners: ["platform"], tags: [] },
  ],
  total_entries: 2,
};

let tools: CapturedTools;
let http: FetchStub | undefined;

function serve(reply: StubReply): FetchStub {
  http?.restore();
  http = stubFetch(reply);
  return http;
}

/** Run `fn` against a self-hosted Airflow with Basic credentials. */
function configured(fn: () => Promise<void>): Promise<void> {
  return withEnv(
    {
      AIRFLOW_URL: "https://airflow.example.com/",
      AIRFLOW_USERNAME: "ada",
      AIRFLOW_PASSWORD: "s3cret",
    },
    fn,
  );
}

beforeEach(() => {
  tools = captureTools(registerAirflowTools);
});

afterEach(() => {
  http?.restore();
  http = undefined;
});

describe("airflow tools", () => {
  it("registers exactly AIRFLOW_TOOL_NAMES", () => {
    expect(tools.names()).toEqual([...AIRFLOW_TOOL_NAMES].sort(byToolName));
  });

  it("list pages 100 DAGs from offset 0 by default, with Basic auth, unwrapping `dags`", async () => {
    const stub = serve(JSON.stringify(DAGS));
    await configured(async () => {
      expect(await tools.callJson("airflow_list", {})).toEqual({ items: DAGS.dags });
      await tools.call("airflow_list", { offset: 200 });
    });
    expect(stub.calls.map((c) => c.url)).toEqual([
      "https://airflow.example.com/api/v1/dags?limit=100&offset=0",
      "https://airflow.example.com/api/v1/dags?limit=100&offset=200",
    ]);
    expect(stub.calls[0]?.headers["authorization"]).toBe(
      `Basic ${Buffer.from("ada:s3cret").toString("base64")}`,
    );
  });

  it("list returns no items when the answer carries no `dags` array", async () => {
    serve('{"total_entries":0}');
    await configured(async () => {
      expect(await tools.callJson("airflow_list", {})).toEqual({ items: [] });
    });
  });

  it("get fetches one DAG by its encoded id", async () => {
    const stub = serve('{"dag_id":"a/b"}');
    await configured(async () => {
      expect(await tools.callJson("airflow_get", { dag_id: "a/b" })).toEqual({ dag_id: "a/b" });
    });
    expect(stub.only.url).toBe("https://airflow.example.com/api/v1/dags/a%2Fb");
  });

  it("search matches dag id, description, owners and tag names on the first page", async () => {
    const stub = serve(JSON.stringify(DAGS));
    const ids = async (query: string): Promise<unknown[]> => {
      let out: unknown;
      await configured(async () => {
        out = await tools.callJson("airflow_search", { query });
      });
      return (out as { matches: { dag_id: string }[] }).matches.map((m) => m.dag_id);
    };
    expect(await ids("ORDERS")).toEqual(["etl_orders"]);
    expect(await ids("load")).toEqual(["etl_orders"]);
    expect(await ids("platform")).toEqual(["refresh_cache"]);
    expect(await ids("prod")).toEqual(["etl_orders"]);
    expect(await ids("nightly")).toEqual([]);
    expect(stub.calls[0]?.url).toBe("https://airflow.example.com/api/v1/dags?limit=100&offset=0");
  });

  it("refuses without a password, before any request, and quotes an API failure", async () => {
    const stub = serve("{}");
    await withEnv(
      {
        AIRFLOW_URL: "https://airflow.example.com",
        AIRFLOW_USERNAME: "ada",
        AIRFLOW_PASSWORD: undefined,
      },
      async () => {
        await expect(tools.call("airflow_list", {})).rejects.toThrow("AIRFLOW_PASSWORD is not set");
      },
    );
    expect(stub.calls).toEqual([]);

    serve({ status: 404, body: "DAG not found" });
    await configured(async () => {
      await expect(tools.call("airflow_get", { dag_id: "nope" })).rejects.toThrow(
        "Airflow 404: DAG not found",
      );
    });
  });
});
