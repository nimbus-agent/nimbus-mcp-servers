import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  type CapturedTools,
  captureTools,
  type FetchStub,
  type StubReply,
  stubFetch,
  withEnv,
} from "../../../scripts/connector-tool-harness.ts";
import { NEWRELIC_TOOL_NAMES, registerNewrelicTools } from "../src/tools.ts";

const API = "https://api.newrelic.com/v2";

let tools: CapturedTools;
let http: FetchStub | undefined;

function serve(reply: StubReply): FetchStub {
  http?.restore();
  http = stubFetch(reply);
  return http;
}

function configured(fn: () => Promise<void>): Promise<void> {
  return withEnv({ NEW_RELIC_API_KEY: "NRAK-key" }, fn);
}

beforeEach(() => {
  tools = captureTools(registerNewrelicTools);
});

afterEach(() => {
  http?.restore();
  http = undefined;
});

describe("newrelic tools", () => {
  it("registers exactly NEWRELIC_TOOL_NAMES, in order", () => {
    expect(tools.registrationOrder()).toEqual([...NEWRELIC_TOOL_NAMES]);
  });

  it("application_list reads the APM applications with a bare X-Api-Key", async () => {
    const stub = serve('{"applications":[{"id":1}]}');
    await configured(async () => {
      expect(await tools.callJson("newrelic_application_list", {})).toEqual({
        applications: [{ id: 1 }],
      });
    });
    expect(stub.only.url).toBe(`${API}/applications.json`);
    expect(stub.only.headers["x-api-key"]).toBe("NRAK-key");
    expect(stub.only.headers["authorization"]).toBeUndefined();
  });

  it("alert_violations asks for open violations only when told to", async () => {
    const stub = serve('{"violations":[]}');
    await configured(async () => {
      await tools.call("newrelic_alert_violations", {});
      await tools.call("newrelic_alert_violations", { only_open: true });
      await tools.call("newrelic_alert_violations", { only_open: false });
    });
    expect(stub.calls.map((c) => c.url)).toEqual([
      `${API}/alerts_violations.json?only_open=false`,
      `${API}/alerts_violations.json?only_open=true`,
      `${API}/alerts_violations.json?only_open=false`,
    ]);
  });

  it("refuses without NEW_RELIC_API_KEY, before any request, and quotes an API failure", async () => {
    const stub = serve("{}");
    await withEnv({ NEW_RELIC_API_KEY: undefined }, async () => {
      await expect(tools.call("newrelic_application_list", {})).rejects.toThrow(
        "NEW_RELIC_API_KEY is not set",
      );
    });
    expect(stub.calls).toEqual([]);

    serve({ status: 403, body: '{"error":{"title":"Forbidden"}}' });
    await configured(async () => {
      await expect(tools.call("newrelic_alert_violations", {})).rejects.toThrow(
        'New Relic 403: {"error":{"title":"Forbidden"}}',
      );
    });
  });
});
