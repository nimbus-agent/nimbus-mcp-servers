import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  type CapturedTools,
  captureTools,
  type FetchStub,
  type StubReply,
  stubFetch,
  withEnv,
} from "../../../scripts/connector-tool-harness.ts";
import { resetConnectorModeForTests, setConnectorMode } from "../../../shared/connector-mode.ts";
import { PAGERDUTY_TOOL_NAMES, registerPagerdutyTools } from "../src/tools.ts";

const API = "https://api.pagerduty.com";

let tools: CapturedTools;
let http: FetchStub | undefined;

function serve(reply: StubReply): FetchStub {
  http?.restore();
  http = stubFetch(reply);
  return http;
}

function configured(fn: () => Promise<void>): Promise<void> {
  return withEnv({ PAGERDUTY_API_TOKEN: "pd-token" }, fn);
}

// Gateway mode: the tool surface itself, with the gateway as the consent gate. The standalone
// gate's scope targets are asserted in scripts/connector-write-scope.test.ts.
beforeEach(() => {
  resetConnectorModeForTests();
  setConnectorMode("gateway");
  tools = captureTools(registerPagerdutyTools);
});

afterEach(() => {
  http?.restore();
  http = undefined;
  resetConnectorModeForTests();
});

describe("pagerduty tools", () => {
  it("registers exactly PAGERDUTY_TOOL_NAMES, in order", () => {
    expect(tools.registrationOrder()).toEqual([...PAGERDUTY_TOOL_NAMES]);
  });

  it("incident_list asks for 25 open incidents by default, with the v2 Accept header", async () => {
    const stub = serve('{"incidents":[]}');
    await configured(async () => {
      expect(await tools.callJson("pd_incident_list", {})).toEqual({ incidents: [] });
    });
    expect(stub.only.url).toBe(
      `${API}/incidents?limit=25&statuses%5B%5D=triggered&statuses%5B%5D=acknowledged`,
    );
    expect(stub.only.headers["authorization"]).toBe("Token token=pd-token");
    expect(stub.only.headers["accept"]).toBe("application/vnd.pagerduty+json;version=2");
  });

  it("incident_list sends the statuses and limit it is given", async () => {
    const stub = serve('{"incidents":[]}');
    await configured(async () => {
      await tools.call("pd_incident_list", { statuses: ["resolved"], limit: 5 });
    });
    expect(stub.only.url).toBe(`${API}/incidents?limit=5&statuses%5B%5D=resolved`);
  });

  it("incident_get fetches one incident by its encoded id", async () => {
    const stub = serve('{"incident":{"id":"P1"}}');
    await configured(async () => {
      expect(await tools.callJson("pd_incident_get", { incidentId: "P/1" })).toEqual({
        incident: { id: "P1" },
      });
    });
    expect(stub.only.url).toBe(`${API}/incidents/P%2F1`);
  });

  for (const action of ["acknowledge", "resolve", "escalate"] as const) {
    it(`incident_${action} PUTs an incident reference to /incidents/{id}/${action}`, async () => {
      const stub = serve('{"incident":{"id":"P1"}}');
      await configured(async () => {
        expect(await tools.callJson(`pd_incident_${action}`, { incidentId: "P1" })).toEqual({
          incident: { id: "P1" },
        });
      });
      expect(`${stub.only.method} ${stub.only.url}`).toBe(`PUT ${API}/incidents/P1/${action}`);
      expect(JSON.parse(stub.only.body ?? "null")).toEqual({
        incident: { type: "incident_reference", id: "P1" },
      });
    });
  }

  it("a status change answered with no JSON body reports ok", async () => {
    serve("");
    await configured(async () => {
      expect(await tools.callJson("pd_incident_resolve", { incidentId: "P1" })).toEqual({
        ok: true,
      });
    });
  });

  it("a refused status change names the action, the status and the body", async () => {
    serve({ status: 403, body: "Access Denied" });
    await configured(async () => {
      await expect(tools.call("pd_incident_escalate", { incidentId: "P1" })).rejects.toThrow(
        "PagerDuty escalate 403: Access Denied",
      );
    });
  });

  it("refuses without PAGERDUTY_API_TOKEN, before any request", async () => {
    const stub = serve("{}");
    await withEnv({ PAGERDUTY_API_TOKEN: undefined }, async () => {
      await expect(tools.call("pd_incident_list", {})).rejects.toThrow(
        "PAGERDUTY_API_TOKEN is not set",
      );
      await expect(tools.call("pd_incident_acknowledge", { incidentId: "P1" })).rejects.toThrow(
        "PAGERDUTY_API_TOKEN is not set",
      );
    });
    expect(stub.calls).toEqual([]);
  });
});
