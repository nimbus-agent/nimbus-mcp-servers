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
  return withEnv(
    { PAGERDUTY_API_TOKEN: "pd-token", PAGERDUTY_FROM_EMAIL: "oncall@example.com" },
    fn,
  );
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

  const STATUS_WORD = { acknowledge: "acknowledged", resolve: "resolved" } as const;
  for (const action of ["acknowledge", "resolve"] as const) {
    it(`incident_${action} PUTs the status to /incidents/{id} with the From header`, async () => {
      const stub = serve('{"incident":{"id":"P1"}}');
      await configured(async () => {
        expect(await tools.callJson(`pd_incident_${action}`, { incidentId: "P1" })).toEqual({
          incident: { id: "P1" },
        });
      });
      expect(`${stub.only.method} ${stub.only.url}`).toBe(`PUT ${API}/incidents/P1`);
      expect(stub.only.headers["from"]).toBe("oncall@example.com");
      expect(JSON.parse(stub.only.body ?? "null")).toEqual({
        incident: { type: "incident_reference", status: STATUS_WORD[action] },
      });
    });

    it(`incident_${action} refuses a missing or malformed From email before any request`, async () => {
      const stub = serve("{}");
      for (const from of [undefined, "", "not-an-email", "a b@c.d"]) {
        await withEnv({ PAGERDUTY_API_TOKEN: "pd-token", PAGERDUTY_FROM_EMAIL: from }, async () => {
          await expect(tools.call(`pd_incident_${action}`, { incidentId: "P1" })).rejects.toThrow(
            /PAGERDUTY_FROM_EMAIL/,
          );
        });
      }
      expect(stub.calls).toEqual([]);
    });

    it(`incident_${action} refuses a redirect and does not follow it`, async () => {
      const stub = serve({ status: 307, headers: { Location: "https://evil.example/x" } });
      await configured(async () => {
        await expect(tools.call(`pd_incident_${action}`, { incidentId: "P1" })).rejects.toThrow(
          /answered a PUT with a redirect \(307\)/,
        );
      });
      expect(stub.calls).toHaveLength(1);
    });
  }

  for (const bad of ["", "P/1", "P1?x=1", "a".repeat(65)]) {
    it(`refuses incidentId ${JSON.stringify(bad.slice(0, 12))} before any request`, async () => {
      const stub = serve("{}");
      await configured(async () => {
        await expect(tools.call("pd_incident_resolve", { incidentId: bad })).rejects.toThrow();
      });
      expect(stub.calls).toEqual([]);
    });
  }

  it("incident_escalate PUTs escalation_level to /incidents/{id} with the From header", async () => {
    const stub = serve('{"incident":{"id":"P1"}}');
    await configured(async () => {
      await tools.call("pd_incident_escalate", { incidentId: "P1", escalationLevel: 2 });
    });
    expect(`${stub.only.method} ${stub.only.url}`).toBe(`PUT ${API}/incidents/P1`);
    expect(stub.only.headers["from"]).toBe("oncall@example.com");
    expect(JSON.parse(stub.only.body ?? "null")).toEqual({
      incident: { type: "incident_reference", escalation_level: 2 },
    });
  });

  it("incident_escalate refuses a missing or out-of-range level before any request", async () => {
    const stub = serve("{}");
    await configured(async () => {
      for (const extra of [
        {},
        { escalationLevel: 0 },
        { escalationLevel: 21 },
        { escalationLevel: 1.5 },
      ]) {
        await expect(
          tools.call("pd_incident_escalate", { incidentId: "P1", ...extra }),
        ).rejects.toThrow();
      }
    });
    expect(stub.calls).toEqual([]);
  });

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
      await expect(tools.call("pd_incident_resolve", { incidentId: "P1" })).rejects.toThrow(
        "PagerDuty resolve 403: Access Denied",
      );
    });
  });

  it("refuses without PAGERDUTY_API_TOKEN, before any request", async () => {
    const stub = serve("{}");
    await withEnv({ PAGERDUTY_API_TOKEN: undefined, PAGERDUTY_FROM_EMAIL: "a@b.co" }, async () => {
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
