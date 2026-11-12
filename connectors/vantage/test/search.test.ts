import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  type CapturedTools,
  captureTools,
  type FetchStub,
  stubFetch,
  withEnv,
} from "../../../scripts/connector-tool-harness.ts";
import { registerVantageToolsWith } from "../src/tools.ts";
import { RECOMMENDATIONS_PAGE, TEST_TOKEN } from "./fixtures.ts";

let tools: CapturedTools;
let http: FetchStub | undefined;

beforeEach(() => {
  tools = captureTools((reg) =>
    registerVantageToolsWith(reg, { now: () => 0, sleep: async () => undefined }),
  );
});

afterEach(() => {
  http?.restore();
  http = undefined;
});

describe("vantage_search", () => {
  it("makes one request for the active recommendations and filters them", async () => {
    const stub = stubFetch(JSON.stringify(RECOMMENDATIONS_PAGE));
    http = stub;
    await withEnv(
      { VANTAGE_API_TOKEN: TEST_TOKEN, VANTAGE_WORKSPACE_TOKEN: undefined },
      async () => {
        expect(await tools.callJson("vantage_search", { query: "intelligent-tiering" })).toEqual({
          matches: [RECOMMENDATIONS_PAGE.recommendations[1]],
        });
      },
    );
    const url = new URL(stub.only.url);
    expect(stub.only.method).toBe("GET");
    expect(url.origin + url.pathname).toBe("https://api.vantage.sh/v2/recommendations");
    expect(Object.fromEntries(url.searchParams.entries())).toEqual({
      status: "active",
      limit: "1000",
    });
    expect(stub.only.headers["authorization"]).toBe(`Bearer ${TEST_TOKEN}`);
  });

  it("returns an empty match set when the reply holds no recommendations array", async () => {
    http = stubFetch("{}");
    await withEnv({ VANTAGE_API_TOKEN: TEST_TOKEN }, async () => {
      expect(await tools.callJson("vantage_search", { query: "x" })).toEqual({ matches: [] });
    });
  });

  it("refuses an empty query and a limit above 200, before any request", async () => {
    const stub = stubFetch(JSON.stringify(RECOMMENDATIONS_PAGE));
    http = stub;
    await withEnv({ VANTAGE_API_TOKEN: TEST_TOKEN }, async () => {
      await expect(tools.call("vantage_search", { query: "" })).rejects.toThrow();
      await expect(tools.call("vantage_search", { query: "x", limit: 201 })).rejects.toThrow();
    });
    expect(stub.calls).toHaveLength(0);
  });
});
