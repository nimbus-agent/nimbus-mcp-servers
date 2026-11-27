import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  approvedStandaloneWrite,
  type CapturedTools,
  captureStandaloneTools,
  captureTools,
  type FetchStub,
  type RecordedRequest,
  type StubReply,
  stubFetch,
  withEnv,
} from "../../../scripts/connector-tool-harness.ts";
import { resetConnectorModeForTests, setConnectorMode } from "../../../shared/connector-mode.ts";
import { registerUnleashTools, UNLEASH_TOOL_NAMES } from "../src/tools.ts";

const ROOT = "https://unleash.example.test";
const TOKEN = "fake-unleash-token";
const ENV_URL = `${ROOT}/api/admin/projects/web/features/new-checkout/environments/production`;
const ARGS = { projectId: "web", featureName: "new-checkout", environment: "production" };

let http: FetchStub | undefined;

function serve(reply: StubReply | ((req: RecordedRequest) => StubReply | undefined)): FetchStub {
  http?.restore();
  http = stubFetch(reply);
  return http;
}

const configured = (fn: () => Promise<void>): Promise<void> =>
  withEnv({ UNLEASH_API_URL: ROOT, UNLEASH_API_TOKEN: TOKEN }, fn);

/** The toggle answers 200 with no body; the state read after it answers `enabled`. */
const toggled =
  (enabled: boolean) =>
  (req: RecordedRequest): StubReply =>
    req.method === "POST" ? { status: 200, body: "" } : JSON.stringify({ enabled });

beforeEach(() => {
  resetConnectorModeForTests();
});

afterEach(() => {
  http?.restore();
  http = undefined;
  resetConnectorModeForTests();
});

describe("unleash_feature_toggle (gateway mode)", () => {
  let tools: CapturedTools;

  beforeEach(() => {
    setConnectorMode("gateway");
    tools = captureTools(registerUnleashTools);
  });

  for (const enabled of [true, false]) {
    it(`POSTs .../${enabled ? "on" : "off"} with no body, then reads the state back`, async () => {
      const stub = serve(toggled(enabled));
      await configured(async () => {
        expect(await tools.callJson("unleash_feature_toggle", { ...ARGS, enabled })).toEqual({
          ok: true,
          ...ARGS,
          confirmed: true,
          enabled,
        });
      });
      expect(stub.calls.map((c) => `${c.method} ${c.url}`)).toEqual([
        `POST ${ENV_URL}/${enabled ? "on" : "off"}`,
        `GET ${ENV_URL}`,
      ]);
      const post = stub.calls[0];
      expect(post?.headers["authorization"]).toBe(TOKEN);
      expect(post?.body).toBeUndefined();
      expect(post?.headers["content-type"]).toBeUndefined();
      expect(post?.redirect).toBe("manual");
    });
  }

  it("accepts '.', '_', '~' and '-' in every path value and places each in its own segment", async () => {
    const stub = serve(toggled(true));
    await configured(async () => {
      await tools.call("unleash_feature_toggle", {
        projectId: "p~1",
        featureName: "a.b_c-d",
        environment: "pre~prod",
        enabled: true,
      });
    });
    expect(stub.calls[0]?.url).toBe(
      `${ROOT}/api/admin/projects/p~1/features/a.b_c-d/environments/pre~prod/on`,
    );
  });

  it("says in its description that enabling may add a default strategy toggling off keeps", () => {
    const description = tools.get("unleash_feature_toggle").description;
    expect(description).toMatch(/no active strategy/);
    expect(description).toMatch(/adds a default strategy/);
    expect(description).toMatch(/toggling off does not remove it/);
    expect(description).not.toMatch(/untouched/);
  });

  it("reports confirmed:false when the read after the write shows another state", async () => {
    serve(toggled(false));
    await configured(async () => {
      expect(
        await tools.callJson("unleash_feature_toggle", { ...ARGS, enabled: true }),
      ).toMatchObject({ ok: true, confirmed: false, enabled: false });
    });
  });

  it("reports the write as done, unconfirmed, when the read after it fails", async () => {
    serve((req) =>
      req.method === "POST" ? { status: 200, body: "" } : { status: 503, body: "busy" },
    );
    await configured(async () => {
      expect(
        await tools.callJson("unleash_feature_toggle", { ...ARGS, enabled: true }),
      ).toMatchObject({ ok: true, confirmed: false, confirmError: expect.stringMatching(/503/) });
    });
  });

  it("refuses a dot segment or path character in any value, sending nothing", async () => {
    const stub = serve("{}");
    await configured(async () => {
      for (const key of ["projectId", "featureName", "environment"] as const) {
        for (const bad of ["..", ".", "a/b", "a?b", "a#b", "a b", ""]) {
          await expect(
            tools.call("unleash_feature_toggle", { ...ARGS, [key]: bad, enabled: true }),
          ).rejects.toThrow(/letters, digits/);
        }
      }
    });
    expect(stub.calls).toEqual([]);
  });

  it("refuses a redirect on the write and never follows it", async () => {
    const stub = serve({ status: 307, headers: { Location: "https://evil.test/steal" } });
    await configured(async () => {
      await expect(
        tools.call("unleash_feature_toggle", { ...ARGS, enabled: true }),
      ).rejects.toThrow(/redirect \(307\); the write may or may not have been applied/);
    });
    expect(stub.calls).toHaveLength(1);
  });

  it("quotes Unleash's refusal with its status, bounded and without the token", async () => {
    serve({ status: 403, body: `change requests are enabled ${"x".repeat(1000)}` });
    await configured(async () => {
      const err = await tools.call("unleash_feature_toggle", { ...ARGS, enabled: true }).then(
        () => undefined,
        (e: unknown) => e as Error,
      );
      expect(err?.message).toMatch(/^Unleash POST .*\/on 403: change requests are enabled/);
      expect(err?.message.length).toBeLessThan(600);
      expect(err?.message).not.toContain(TOKEN);
    });
  });

  it("refuses without UNLEASH_API_URL or UNLEASH_API_TOKEN before any request", async () => {
    const stub = serve("{}");
    await withEnv({ UNLEASH_API_URL: undefined, UNLEASH_API_TOKEN: TOKEN }, async () => {
      await expect(
        tools.call("unleash_feature_toggle", { ...ARGS, enabled: true }),
      ).rejects.toThrow("UNLEASH_API_URL is not set");
    });
    await withEnv({ UNLEASH_API_URL: ROOT, UNLEASH_API_TOKEN: undefined }, async () => {
      await expect(
        tools.call("unleash_feature_toggle", { ...ARGS, enabled: true }),
      ).rejects.toThrow("UNLEASH_API_TOKEN is not set");
    });
    await withEnv(
      { UNLEASH_API_URL: "http://unleash.example.test", UNLEASH_API_TOKEN: TOKEN },
      async () => {
        await expect(
          tools.call("unleash_feature_toggle", { ...ARGS, enabled: true }),
        ).rejects.toThrow(/UNLEASH_API_URL must be an https URL/);
      },
    );
    expect(stub.calls).toEqual([]);
  });
});

describe("unleash_feature_toggle (standalone mode)", () => {
  beforeEach(() => {
    setConnectorMode("standalone");
  });

  it("is a write: listed only to a client that can ask a human, beside every read", async () => {
    const reads = UNLEASH_TOOL_NAMES.filter((n) => n !== "unleash_feature_toggle");
    await withEnv({ NIMBUS_MCP_UNLEASH_WRITE_SCOPE: "flag:web/production/new-checkout" }, () => {
      const blind = captureStandaloneTools(registerUnleashTools, { elicitation: false }).tools;
      expect(blind.names()).toEqual([...reads].sort((a, b) => a.localeCompare(b)));
      const asking = captureStandaloneTools(registerUnleashTools, { elicitation: true }).tools;
      expect(asking.names()).toEqual([...UNLEASH_TOOL_NAMES].sort((a, b) => a.localeCompare(b)));
    });
  });

  it("runs approved and in scope, recording the strategies BEFORE the POST", async () => {
    // Enabling an environment with no active strategy makes Unleash add a default one that
    // toggling off does not remove, so the previous strategies are the audited pre-state.
    let posted = false;
    const stub = serve((req) => {
      if (req.method === "POST") {
        posted = true;
        return { status: 200, body: "" };
      }
      return JSON.stringify(
        posted
          ? { enabled: true, strategies: [{ name: "flexibleRollout", id: "new" }] }
          : { enabled: false, strategies: [] },
      );
    });
    await configured(async () => {
      const run = await approvedStandaloneWrite(
        registerUnleashTools,
        { NIMBUS_MCP_UNLEASH_WRITE_SCOPE: "flag:web/production/new-checkout" },
        "unleash_feature_toggle",
        { ...ARGS, enabled: true },
      );
      expect(run.answer).toMatchObject({ ok: true, confirmed: true, enabled: true });
      expect(run.chain.ok).toBe(true);
      const executed = run.audit.find((e) => e.outcome === "executed");
      expect(executed?.detail["preState"]).toMatchObject({ enabled: false, strategies: [] });
    });
    expect(stub.calls.map((c) => c.method)).toEqual(["GET", "POST", "GET"]);
  });
});
