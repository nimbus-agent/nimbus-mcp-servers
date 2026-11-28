import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { approvedStandaloneWrite } from "../../../scripts/connector-tool-harness.ts";
import { resetConnectorModeForTests, setConnectorMode } from "../../../shared/connector-mode.ts";
import { registerLookerTools } from "../src/server.ts";

describe("looker_schedule_run_once is not recoverable (standalone mode)", () => {
  const origFetch = globalThis.fetch;
  let methods: string[] = [];

  beforeEach(() => {
    resetConnectorModeForTests();
    setConnectorMode("standalone");
    methods = [];
    process.env["LOOKER_BASE_URL"] = "https://looker.example.com";
    process.env["LOOKER_CLIENT_ID"] = "id";
    process.env["LOOKER_CLIENT_SECRET"] = "secret";
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      if (String(url).includes("/api/4.0/login")) {
        return new Response(JSON.stringify({ access_token: "tok" }), { status: 200 });
      }
      methods.push(String(init?.method));
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = origFetch;
    delete process.env["LOOKER_BASE_URL"];
    delete process.env["LOOKER_CLIENT_ID"];
    delete process.env["LOOKER_CLIENT_SECRET"];
    resetConnectorModeForTests();
  });

  it("audits the plan id as the pre-state, with no request beyond the run itself", async () => {
    const done = await approvedStandaloneWrite(
      registerLookerTools,
      { NIMBUS_MCP_LOOKER_WRITE_SCOPE: "resource:sp-2" },
      "looker_schedule_run_once",
      { scheduledPlanId: "sp-2" },
    );
    expect(methods).toEqual(["POST"]);
    expect(done.audit.find((e) => e.outcome === "executed")?.detail["preState"]).toEqual({
      scheduledPlanId: "sp-2",
    });
    expect(done.chain.ok).toBe(true);
  });
});
