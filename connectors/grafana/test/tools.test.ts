import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  type CapturedTools,
  captureTools,
  type FetchStub,
  type StubReply,
  stubFetch,
  withEnv,
} from "../../../scripts/connector-tool-harness.ts";
import { GRAFANA_TOOL_NAMES, registerGrafanaTools } from "../src/tools.ts";

const BASE = "https://grafana.example.com";

let tools: CapturedTools;
let http: FetchStub | undefined;

function serve(reply: StubReply): FetchStub {
  http?.restore();
  http = stubFetch(reply);
  return http;
}

function configured(fn: () => Promise<void>): Promise<void> {
  return withEnv({ GRAFANA_URL: `${BASE}/`, GRAFANA_API_TOKEN: "glsa_token" }, fn);
}

beforeEach(() => {
  tools = captureTools(registerGrafanaTools);
});

afterEach(() => {
  http?.restore();
  http = undefined;
});

describe("grafana tools", () => {
  it("registers exactly GRAFANA_TOOL_NAMES, in order", () => {
    expect(tools.registrationOrder()).toEqual([...GRAFANA_TOOL_NAMES]);
  });

  it("alert_list reads the Ruler rules with a bearer token", async () => {
    const stub = serve('{"folder":[{"name":"cpu"}]}');
    await configured(async () => {
      expect(await tools.callJson("grafana_alert_list", {})).toEqual({
        folder: [{ name: "cpu" }],
      });
    });
    expect(stub.only.url).toBe(`${BASE}/api/ruler/grafana/api/v1/rules`);
    expect(stub.only.headers["authorization"]).toBe("Bearer glsa_token");
  });

  it("dashboard_list searches dashboards, with an empty query when none is given", async () => {
    const stub = serve("[]");
    await configured(async () => {
      await tools.call("grafana_dashboard_list", {});
      await tools.call("grafana_dashboard_list", { query: "api latency" });
    });
    expect(stub.calls.map((c) => c.url)).toEqual([
      `${BASE}/api/search?type=dash-db&query=`,
      `${BASE}/api/search?type=dash-db&query=api%20latency`,
    ]);
  });

  it("drops only ONE trailing slash from GRAFANA_URL", async () => {
    const stub = serve("[]");
    await withEnv({ GRAFANA_URL: `${BASE}/sub//`, GRAFANA_API_TOKEN: "t" }, async () => {
      await tools.call("grafana_alert_list", {});
    });
    expect(stub.only.url).toBe(`${BASE}/sub//api/ruler/grafana/api/v1/rules`);
  });

  it("returns a non-JSON answer as raw text rather than failing to parse it", async () => {
    serve("<html>Grafana</html>");
    await configured(async () => {
      expect(await tools.callJson("grafana_alert_list", {})).toEqual({
        raw: "<html>Grafana</html>",
      });
    });
  });

  it("refuses without GRAFANA_URL, before any request, and quotes an API failure", async () => {
    const stub = serve("[]");
    await withEnv({ GRAFANA_URL: undefined, GRAFANA_API_TOKEN: "t" }, async () => {
      await expect(tools.call("grafana_alert_list", {})).rejects.toThrow("GRAFANA_URL is not set");
    });
    expect(stub.calls).toEqual([]);

    serve({ status: 401, body: '{"message":"invalid API key"}' });
    await configured(async () => {
      await expect(tools.call("grafana_dashboard_list", {})).rejects.toThrow(
        'Grafana 401: {"message":"invalid API key"}',
      );
    });
  });
});
