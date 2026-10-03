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
import { PREFECT_TOOL_NAMES, registerPrefectTools } from "../src/tools.ts";

const API = "https://prefect.example.com/api";

const DEPLOYMENTS = [
  {
    id: "d-1",
    name: "nightly-etl",
    description: "Loads the warehouse",
    work_pool_name: "k8s-pool",
    work_queue_name: "default",
    status: "READY",
    tags: ["prod"],
  },
  { id: "d-2", name: "adhoc", description: null, status: "NOT_READY", tags: [] },
];

let tools: CapturedTools;
let http: FetchStub | undefined;

function serve(reply: StubReply): FetchStub {
  http?.restore();
  http = stubFetch(reply);
  return http;
}

/** Prefect Cloud: an API key is sent as a bearer token. */
function cloud(fn: () => Promise<void>): Promise<void> {
  return withEnv({ PREFECT_API_URL: `${API}/`, PREFECT_API_KEY: "pnu_key" }, fn);
}

beforeEach(() => {
  tools = captureTools(registerPrefectTools);
});

afterEach(() => {
  http?.restore();
  http = undefined;
});

describe("prefect tools", () => {
  it("registers exactly PREFECT_TOOL_NAMES", () => {
    expect(tools.names()).toEqual([...PREFECT_TOOL_NAMES].sort(byToolName));
  });

  it("list POSTs the deployments filter, newest first, from offset 0 by default", async () => {
    const stub = serve(JSON.stringify(DEPLOYMENTS));
    await cloud(async () => {
      expect(await tools.callJson("prefect_list", {})).toEqual({ items: DEPLOYMENTS });
      await tools.call("prefect_list", { offset: 100 });
    });
    expect(stub.calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      `POST ${API}/deployments/filter`,
      `POST ${API}/deployments/filter`,
    ]);
    expect(stub.calls.map((c) => JSON.parse(c.body ?? "null") as unknown)).toEqual([
      { limit: 100, offset: 0, sort: "CREATED_DESC" },
      { limit: 100, offset: 100, sort: "CREATED_DESC" },
    ]);
    expect(stub.calls[0]?.headers["authorization"]).toBe("Bearer pnu_key");
    expect(stub.calls[0]?.headers["content-type"]).toBe("application/json");
  });

  it("a self-hosted server without a key is called with no Authorization header", async () => {
    const stub = serve(JSON.stringify(DEPLOYMENTS));
    await withEnv({ PREFECT_API_URL: API, PREFECT_API_KEY: " " }, async () => {
      await tools.call("prefect_list", {});
      await tools.call("prefect_get", { id: "d-1" });
    });
    expect(stub.calls.map((c) => c.headers["authorization"])).toEqual([undefined, undefined]);
    expect(stub.calls[1]?.url).toBe(`${API}/deployments/d-1`);
  });

  it("list returns no items when the answer is not an array", async () => {
    serve('{"detail":"unexpected"}');
    await cloud(async () => {
      expect(await tools.callJson("prefect_list", {})).toEqual({ items: [] });
    });
  });

  it("search matches name, description, pool, queue, status and tags", async () => {
    serve(JSON.stringify(DEPLOYMENTS));
    const ids = async (query: string): Promise<unknown[]> => {
      let out: unknown;
      await cloud(async () => {
        out = await tools.callJson("prefect_search", { query });
      });
      return (out as { matches: { id: string }[] }).matches.map((m) => m.id);
    };
    expect(await ids("NIGHTLY")).toEqual(["d-1"]);
    expect(await ids("warehouse")).toEqual(["d-1"]);
    expect(await ids("k8s")).toEqual(["d-1"]);
    expect(await ids("not_ready")).toEqual(["d-2"]);
    expect(await ids("prod")).toEqual(["d-1"]);
    expect(await ids("weekly")).toEqual([]);
  });

  it("refuses without PREFECT_API_URL, before any request, and quotes a failure", async () => {
    const stub = serve("[]");
    await withEnv({ PREFECT_API_URL: undefined }, async () => {
      await expect(tools.call("prefect_list", {})).rejects.toThrow("PREFECT_API_URL is not set");
    });
    expect(stub.calls).toEqual([]);

    serve({ status: 422, body: "invalid sort" });
    await cloud(async () => {
      await expect(tools.call("prefect_list", {})).rejects.toThrow("Prefect 422: invalid sort");
    });
  });
});
