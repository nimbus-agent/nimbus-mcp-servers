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
import { METABASE_TOOL_NAMES, registerMetabaseTools } from "../src/tools.ts";

const BASE = "https://metabase.example.com";

const DASHBOARDS = [
  { id: 1, name: "Revenue", description: "Monthly revenue by region" },
  { id: 2, name: "Funnel", description: null },
  { id: 3, name: "Churn", description: "Weekly churn" },
];

let tools: CapturedTools;
let http: FetchStub | undefined;

function serve(reply: StubReply): FetchStub {
  http?.restore();
  http = stubFetch(reply);
  return http;
}

function configured(fn: () => Promise<void>): Promise<void> {
  return withEnv({ METABASE_URL: `${BASE}/`, METABASE_API_KEY: "mb_key" }, fn);
}

/** The ids `metabase_search` returns for `query`. */
async function searchIds(query: string): Promise<unknown[]> {
  let out: unknown;
  await configured(async () => {
    out = await tools.callJson("metabase_search", { query });
  });
  return (out as { matches: { id: number }[] }).matches.map((m) => m.id);
}

beforeEach(() => {
  tools = captureTools(registerMetabaseTools);
});

afterEach(() => {
  http?.restore();
  http = undefined;
});

describe("metabase tools", () => {
  it("registers exactly METABASE_TOOL_NAMES", () => {
    expect(tools.names()).toEqual([...METABASE_TOOL_NAMES].sort(byToolName));
  });

  it("list reads a bare array or a `data` envelope, capped at `limit`, with x-api-key", async () => {
    const stub = serve(JSON.stringify(DASHBOARDS));
    await configured(async () => {
      expect(await tools.callJson("metabase_list", {})).toEqual({ items: DASHBOARDS });
      expect(await tools.callJson("metabase_list", { limit: 2 })).toEqual({
        items: DASHBOARDS.slice(0, 2),
      });
    });
    expect(stub.calls.map((c) => c.url)).toEqual([
      `${BASE}/api/dashboard`,
      `${BASE}/api/dashboard`,
    ]);
    expect(stub.calls[0]?.headers["x-api-key"]).toBe("mb_key");

    serve(JSON.stringify({ data: DASHBOARDS.slice(2) }));
    await configured(async () => {
      expect(await tools.callJson("metabase_list", {})).toEqual({ items: DASHBOARDS.slice(2) });
    });

    serve('{"total":0}');
    await configured(async () => {
      expect(await tools.callJson("metabase_list", {})).toEqual({ items: [] });
    });
  });

  it("get fetches one dashboard by its numeric id", async () => {
    const stub = serve('{"id":7}');
    await configured(async () => {
      expect(await tools.callJson("metabase_get", { id: 7 })).toEqual({ id: 7 });
    });
    expect(stub.only.url).toBe(`${BASE}/api/dashboard/7`);
  });

  it("search matches dashboard name and description, from either response shape", async () => {
    serve(JSON.stringify(DASHBOARDS));
    expect(await searchIds("REVENUE")).toEqual([1]);
    expect(await searchIds("weekly")).toEqual([3]);
    expect(await searchIds("cohort")).toEqual([]);

    serve(JSON.stringify({ data: DASHBOARDS }));
    expect(await searchIds("funnel")).toEqual([2]);
  });

  it("refuses without METABASE_API_KEY, before any request, and quotes an API failure", async () => {
    const stub = serve("[]");
    await withEnv({ METABASE_URL: BASE, METABASE_API_KEY: undefined }, async () => {
      await expect(tools.call("metabase_list", {})).rejects.toThrow("METABASE_API_KEY is not set");
    });
    expect(stub.calls).toEqual([]);

    serve({ status: 404, body: "Not found." });
    await configured(async () => {
      await expect(tools.call("metabase_get", { id: 99 })).rejects.toThrow(
        "Metabase 404: Not found.",
      );
    });
  });
});
