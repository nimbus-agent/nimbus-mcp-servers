import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  type CapturedTools,
  captureTools,
  type FetchStub,
  type StubReply,
  stubFetch,
  withEnv,
} from "../../../scripts/connector-tool-harness.ts";
import { registerVantageToolsWith } from "../src/tools.ts";
import { RECOMMENDATIONS_LAST_PAGE, RECOMMENDATIONS_PAGE, TEST_TOKEN } from "./fixtures.ts";

let tools: CapturedTools;
let http: FetchStub | undefined;

function serve(reply: StubReply): FetchStub {
  http?.restore();
  http = stubFetch(reply);
  return http;
}

function configured(
  fn: () => Promise<void>,
  extra: Record<string, string | undefined> = {},
): Promise<void> {
  return withEnv(
    { VANTAGE_API_TOKEN: TEST_TOKEN, VANTAGE_WORKSPACE_TOKEN: undefined, ...extra },
    fn,
  );
}

beforeEach(() => {
  tools = captureTools((reg) =>
    registerVantageToolsWith(reg, { now: () => 0, sleep: async () => undefined }),
  );
});

afterEach(() => {
  http?.restore();
  http = undefined;
});

describe("vantage_recommendation_list", () => {
  it("sends a GET for active recommendations, 1000 a page, with the Bearer token", async () => {
    const stub = serve(JSON.stringify(RECOMMENDATIONS_LAST_PAGE));
    await configured(async () => {
      await tools.call("vantage_recommendation_list", {});
    });
    const url = new URL(stub.only.url);
    expect(stub.only.method).toBe("GET");
    expect(url.origin + url.pathname).toBe("https://api.vantage.sh/v2/recommendations");
    expect(Object.fromEntries(url.searchParams.entries())).toEqual({
      status: "active",
      limit: "1000",
      page: "1",
    });
    expect(stub.only.headers["authorization"]).toBe(`Bearer ${TEST_TOKEN}`);
  });

  it("honours a smaller limit, refuses one above 1000, and pages by cursor", async () => {
    const stub = serve(JSON.stringify(RECOMMENDATIONS_LAST_PAGE));
    await configured(async () => {
      await tools.call("vantage_recommendation_list", { limit: 50, cursor: "2" });
      await expect(tools.call("vantage_recommendation_list", { limit: 1001 })).rejects.toThrow();
      await expect(tools.call("vantage_recommendation_list", { cursor: "x" })).rejects.toThrow(
        /cursor/,
      );
    });
    expect(stub.calls).toHaveLength(1);
    const q = new URL(stub.only.url).searchParams;
    expect(q.get("limit")).toBe("50");
    expect(q.get("page")).toBe("2");
  });

  it("sends workspace_token when VANTAGE_WORKSPACE_TOKEN is set", async () => {
    const stub = serve(JSON.stringify(RECOMMENDATIONS_LAST_PAGE));
    await configured(
      async () => {
        await tools.call("vantage_recommendation_list", {});
      },
      { VANTAGE_WORKSPACE_TOKEN: "wrkspc_abc" },
    );
    expect(new URL(stub.only.url).searchParams.get("workspace_token")).toBe("wrkspc_abc");
  });

  it("returns the recommendations array as items and the next page as nextCursor", async () => {
    serve(JSON.stringify(RECOMMENDATIONS_PAGE));
    await configured(async () => {
      expect(await tools.callJson("vantage_recommendation_list", { cursor: "1" })).toEqual({
        items: RECOMMENDATIONS_PAGE.recommendations,
        nextCursor: "2",
      });
    });
    serve(JSON.stringify(RECOMMENDATIONS_LAST_PAGE));
    await configured(async () => {
      expect(await tools.callJson("vantage_recommendation_list", {})).toEqual({
        items: [],
        nextCursor: null,
      });
    });
  });

  it("throws a Vantage error carrying the status on a non-2xx reply", async () => {
    serve({ status: 403, body: "forbidden" });
    await configured(async () => {
      await expect(tools.call("vantage_recommendation_list", {})).rejects.toThrow(
        "Vantage 403: forbidden",
      );
    });
  });
});
