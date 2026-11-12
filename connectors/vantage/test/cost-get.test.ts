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
import { COST_REPORT, TEST_TOKEN } from "./fixtures.ts";

let tools: CapturedTools;
let http: FetchStub | undefined;

function serve(reply: StubReply): FetchStub {
  http?.restore();
  http = stubFetch(reply);
  return http;
}

function configured(fn: () => Promise<void>): Promise<void> {
  return withEnv({ VANTAGE_API_TOKEN: TEST_TOKEN }, fn);
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

describe("vantage_cost_get", () => {
  it("fetches one cost report and returns the raw body", async () => {
    const stub = serve(JSON.stringify(COST_REPORT));
    await configured(async () => {
      expect(await tools.callJson("vantage_cost_get", { id: "rprt_example" })).toEqual(COST_REPORT);
    });
    expect(stub.only.method).toBe("GET");
    expect(stub.only.url).toBe("https://api.vantage.sh/v2/cost_reports/rprt_example");
    expect(stub.only.headers["authorization"]).toBe(`Bearer ${TEST_TOKEN}`);
  });

  it("encodes an id holding a slash or a query separator", async () => {
    const stub = serve(JSON.stringify(COST_REPORT));
    await configured(async () => {
      await tools.call("vantage_cost_get", { id: "a/b?c=d#e" });
    });
    expect(stub.only.url).toBe("https://api.vantage.sh/v2/cost_reports/a%2Fb%3Fc%3Dd%23e");
  });

  it("refuses an empty id before any request", async () => {
    const stub = serve(JSON.stringify(COST_REPORT));
    await configured(async () => {
      await expect(tools.call("vantage_cost_get", { id: "" })).rejects.toThrow();
    });
    expect(stub.calls).toHaveLength(0);
  });

  it("throws a Vantage 404 error when the report does not exist", async () => {
    serve({ status: 404, body: '{"errors":["Not Found"]}' });
    await configured(async () => {
      await expect(tools.call("vantage_cost_get", { id: "nope" })).rejects.toThrow("Vantage 404:");
    });
  });
});
