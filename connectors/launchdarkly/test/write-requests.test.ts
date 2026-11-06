import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
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
import { registerLaunchdarklyTools } from "../src/tools.ts";

const API = "https://app.launchdarkly.com/api/v2";
const SEMANTIC = "application/json; domain-model=launchdarkly.semanticpatch";
const COMMENT = "Changed by Nimbus after owner approval";
const FLAG = { projectKey: "web", environmentKey: "production", flagKey: "new-checkout" };

/** Shaped like the documented `GET /flags/{p}/{f}?env=` response; variation ids are the `_id`s. */
const FLAG_DOC = {
  key: "new-checkout",
  _version: 4,
  archived: false,
  variations: [
    { _id: "var-a", name: "Off", value: false },
    { _id: "var-b", name: "On", value: true },
  ],
  environments: {
    production: {
      on: true,
      version: 11,
      offVariation: 0,
      fallthrough: {
        rollout: {
          variations: [
            { variation: 0, weight: 25000 },
            { variation: 1, weight: 75000 },
          ],
        },
      },
    },
    staging: { on: false, offVariation: 0, fallthrough: { variation: 1 } },
  },
};

let http: FetchStub | undefined;

function serve(reply: StubReply | ((req: RecordedRequest) => StubReply | undefined)): FetchStub {
  http?.restore();
  http = stubFetch(reply);
  return http;
}

const withToken = (fn: () => Promise<void>): Promise<void> =>
  withEnv({ LAUNCHDARKLY_TOKEN: "api-ld", LAUNCHDARKLY_BASE_URL: undefined }, fn);

beforeEach(() => {
  resetConnectorModeForTests();
});

afterEach(() => {
  http?.restore();
  http = undefined;
  resetConnectorModeForTests();
});

describe("launchdarkly writes (gateway mode)", () => {
  let tools: CapturedTools;

  beforeEach(() => {
    setConnectorMode("gateway");
    tools = captureTools(registerLaunchdarklyTools);
  });

  it("toggle on sends a semantic patch with the domain-model Content-Type and a bare token", async () => {
    const stub = serve('{"environments":{"production":{"on":true}}}');
    await withToken(async () => {
      expect(await tools.callJson("launchdarkly_flag_toggle", { ...FLAG, on: true })).toEqual({
        ok: true,
        confirmed: true,
        ...FLAG,
        on: true,
      });
    });
    const req = stub.only;
    expect(`${req.method} ${req.url}`).toBe(`PATCH ${API}/flags/web/new-checkout`);
    expect(req.headers["content-type"]).toBe(SEMANTIC);
    expect(req.headers["authorization"]).toBe("api-ld");
    expect(JSON.parse(req.body ?? "null")).toEqual({
      environmentKey: "production",
      comment: COMMENT,
      instructions: [{ kind: "turnFlagOn" }],
    });
  });

  it("toggle reports confirmed:false when the reply echoes the opposite state or none", async () => {
    await withToken(async () => {
      serve('{"environments":{"production":{"on":false}}}');
      expect(await tools.callJson("launchdarkly_flag_toggle", { ...FLAG, on: true })).toMatchObject(
        { ok: true, confirmed: false, on: false },
      );
      serve("{}");
      expect(await tools.callJson("launchdarkly_flag_toggle", { ...FLAG, on: true })).toMatchObject(
        { ok: true, confirmed: false },
      );
      serve('{"environments":{"production":{"on":"true"}}}');
      expect(await tools.callJson("launchdarkly_flag_toggle", { ...FLAG, on: true })).toMatchObject(
        { ok: true, confirmed: false },
      );
    });
  });

  it("rollout_set confirms only when the echoed weights equal the request", async () => {
    const weights = [
      { variationId: "var-a", percent: 60 },
      { variationId: "var-b", percent: 40 },
    ];
    const echo = (a: number, b: number): unknown => ({
      variations: [{ _id: "var-a" }, { _id: "var-b" }],
      environments: {
        production: {
          on: true,
          fallthrough: {
            rollout: {
              variations: [
                { variation: 0, weight: a },
                { variation: 1, weight: b },
              ],
            },
          },
        },
      },
    });
    await withToken(async () => {
      serve(JSON.stringify(echo(60000, 40000)));
      expect(
        await tools.callJson("launchdarkly_flag_rollout_set", { ...FLAG, weights }),
      ).toMatchObject({ ok: true, confirmed: true });
      serve(JSON.stringify(echo(25000, 75000)));
      expect(
        await tools.callJson("launchdarkly_flag_rollout_set", { ...FLAG, weights }),
      ).toMatchObject({ ok: true, confirmed: false });
      serve("{}");
      expect(
        await tools.callJson("launchdarkly_flag_rollout_set", { ...FLAG, weights }),
      ).toMatchObject({ ok: true, confirmed: false });
    });
  });

  it("toggle off sends turnFlagOff", async () => {
    const stub = serve("{}");
    await withToken(async () => {
      await tools.call("launchdarkly_flag_toggle", { ...FLAG, on: false });
    });
    expect(JSON.parse(stub.only.body ?? "null")).toMatchObject({
      instructions: [{ kind: "turnFlagOff" }],
    });
  });

  it("honours LAUNCHDARKLY_BASE_URL", async () => {
    const stub = serve("{}");
    await withEnv(
      { LAUNCHDARKLY_TOKEN: "t", LAUNCHDARKLY_BASE_URL: "https://ld.internal.example" },
      async () => {
        await tools.call("launchdarkly_flag_toggle", { ...FLAG, on: true });
      },
    );
    expect(stub.only.url).toBe("https://ld.internal.example/api/v2/flags/web/new-checkout");
  });

  it("surfaces the 405 an approval-gated environment answers, with its body", async () => {
    serve({ status: 405, body: "approval required" });
    await withToken(async () => {
      await expect(tools.call("launchdarkly_flag_toggle", { ...FLAG, on: true })).rejects.toThrow(
        /405.*approval required/,
      );
    });
  });

  it("refuses keys that could reach another path, before any request", async () => {
    const stub = serve("{}");
    await withToken(async () => {
      for (const bad of ["../x", "a/b", "a b", "a?x=1", "", ".", ".."]) {
        await expect(
          tools.call("launchdarkly_flag_toggle", { ...FLAG, flagKey: bad, on: true }),
        ).rejects.toThrow();
        await expect(
          tools.call("launchdarkly_flag_toggle", { ...FLAG, environmentKey: bad, on: true }),
        ).rejects.toThrow();
      }
    });
    expect(stub.calls).toEqual([]);
  });

  it("refuses a 302 to another origin and sends nothing there", async () => {
    const stub = serve({ status: 302, headers: { Location: "https://evil.test/steal" } });
    await withToken(async () => {
      await expect(tools.call("launchdarkly_flag_toggle", { ...FLAG, on: true })).rejects.toThrow(
        /redirect/i,
      );
    });
    expect(stub.calls.map((c) => c.url)).toEqual([`${API}/flags/web/new-checkout`]);
  });

  it("a read follows no redirect to another origin either", async () => {
    const stub = serve({ status: 302, headers: { Location: "https://evil.test/steal" } });
    await withToken(async () => {
      await expect(tools.call("launchdarkly_flag_state_get", FLAG)).rejects.toThrow(
        /another origin/,
      );
    });
    expect(stub.calls).toHaveLength(1);
  });

  it("rollout_set sends thousandths keyed by variation id", async () => {
    const stub = serve("{}");
    await withToken(async () => {
      await tools.call("launchdarkly_flag_rollout_set", {
        ...FLAG,
        weights: [
          { variationId: "var-a", percent: 60 },
          { variationId: "var-b", percent: 40 },
        ],
      });
    });
    expect(stub.only.headers["content-type"]).toBe(SEMANTIC);
    expect(JSON.parse(stub.only.body ?? "null")).toEqual({
      environmentKey: "production",
      comment: COMMENT,
      instructions: [
        {
          kind: "updateFallthroughVariationOrRollout",
          rolloutWeights: { "var-a": 60000, "var-b": 40000 },
        },
      ],
    });
  });

  it("rollout_set accepts three decimals that sum to 100", async () => {
    const stub = serve("{}");
    await withToken(async () => {
      await tools.call("launchdarkly_flag_rollout_set", {
        ...FLAG,
        weights: [
          { variationId: "a", percent: 33.333 },
          { variationId: "b", percent: 33.333 },
          { variationId: "c", percent: 33.334 },
        ],
      });
    });
    const body = JSON.parse(stub.only.body ?? "null") as {
      instructions: { rolloutWeights: Record<string, number> }[];
    };
    expect(body.instructions[0]?.rolloutWeights).toEqual({ a: 33333, b: 33333, c: 33334 });
  });

  it("rollout_set refuses a bad split before any request", async () => {
    const stub = serve("{}");
    const bad: { variationId: string; percent: number }[][] = [
      [{ variationId: "a", percent: 99.9 }],
      [
        { variationId: "a", percent: 50 },
        { variationId: "b", percent: 50.001 },
      ],
      [
        { variationId: "a", percent: 50 },
        { variationId: "a", percent: 50 },
      ],
      [
        { variationId: "a", percent: 50.0001 },
        { variationId: "b", percent: 49.9999 },
      ],
    ];
    await withToken(async () => {
      for (const weights of bad) {
        await expect(
          tools.call("launchdarkly_flag_rollout_set", { ...FLAG, weights }),
        ).rejects.toThrow();
      }
    });
    expect(stub.calls).toEqual([]);
  });

  it("registers rollout_set with its input fields visible (no refine)", () => {
    const schema = tools.get("launchdarkly_flag_rollout_set").schema as { shape?: object };
    expect(Object.keys(schema.shape ?? {}).sort((a, b) => a.localeCompare(b))).toEqual([
      "environmentKey",
      "flagKey",
      "projectKey",
      "weights",
    ]);
  });

  it("refuses a write without LAUNCHDARKLY_TOKEN before any request", async () => {
    const stub = serve("{}");
    await withEnv({ LAUNCHDARKLY_TOKEN: undefined }, async () => {
      await expect(tools.call("launchdarkly_flag_toggle", { ...FLAG, on: true })).rejects.toThrow(
        "LAUNCHDARKLY_TOKEN is not set",
      );
    });
    expect(stub.calls).toEqual([]);
  });
});

describe("launchdarkly_flag_state_get", () => {
  let tools: CapturedTools;

  beforeEach(() => {
    setConnectorMode("gateway");
    tools = captureTools(registerLaunchdarklyTools);
  });

  it("reads one environment and resolves variation indices to ids", async () => {
    const stub = serve(JSON.stringify(FLAG_DOC));
    await withToken(async () => {
      expect(await tools.callJson("launchdarkly_flag_state_get", FLAG)).toEqual({
        ...FLAG,
        on: true,
        offVariation: 0,
        offVariationId: "var-a",
        fallthrough: {
          rollout: [
            { variation: 0, variationId: "var-a", weightPercent: 25 },
            { variation: 1, variationId: "var-b", weightPercent: 75 },
          ],
        },
        variations: [
          { index: 0, id: "var-a", name: "Off", value: false },
          { index: 1, id: "var-b", name: "On", value: true },
        ],
        version: 11,
        archived: false,
      });
    });
    expect(stub.only.url).toBe(`${API}/flags/web/new-checkout?env=production`);
  });

  it("reports a rollout's bucketBy and contextKind when the read returns them", async () => {
    const doc = structuredClone(FLAG_DOC);
    Object.assign(doc.environments.production.fallthrough.rollout, {
      bucketBy: "email",
      contextKind: "user",
    });
    serve(JSON.stringify(doc));
    await withToken(async () => {
      const out = (await tools.callJson("launchdarkly_flag_state_get", FLAG)) as {
        fallthrough: Record<string, unknown>;
      };
      expect(out.fallthrough["rolloutBucketBy"]).toBe("email");
      expect(out.fallthrough["rolloutContextKind"]).toBe("user");
    });
  });

  it("shows a single-variation fallthrough", async () => {
    serve(JSON.stringify(FLAG_DOC));
    await withToken(async () => {
      const out = (await tools.callJson("launchdarkly_flag_state_get", {
        ...FLAG,
        environmentKey: "staging",
      })) as { fallthrough: unknown; version: unknown };
      expect(out.fallthrough).toEqual({ variation: 1, variationId: "var-b" });
      // No per-environment version: the flag's own _version stands in.
      expect(out.version).toBe(4);
    });
  });

  it("throws when the environment is absent", async () => {
    serve(JSON.stringify(FLAG_DOC));
    await withToken(async () => {
      await expect(
        tools.call("launchdarkly_flag_state_get", { ...FLAG, environmentKey: "qa" }),
      ).rejects.toThrow("environment not found: qa");
    });
  });
});

describe("launchdarkly writes (standalone mode)", () => {
  let auditDir: string;
  let auditLog: string;

  beforeEach(() => {
    setConnectorMode("standalone");
    auditDir = mkdtempSync(join(tmpdir(), "nimbus-ld-audit-"));
    auditLog = join(auditDir, "audit.jsonl");
  });

  afterEach(() => {
    rmSync(auditDir, { recursive: true, force: true });
  });

  async function standalone(scope: string): Promise<CapturedTools> {
    let tools: CapturedTools | undefined;
    await withEnv(
      {
        NIMBUS_MCP_LAUNCHDARKLY_WRITE_SCOPE: scope,
        NIMBUS_MCP_AUDIT_LOG: auditLog,
        NIMBUS_MCP_WRITE_BUDGET: undefined,
      },
      () => {
        tools = captureStandaloneTools(registerLaunchdarklyTools, { elicitation: true }).tools;
      },
    );
    if (tools === undefined) throw new Error("registration did not run");
    return tools;
  }

  it("captures the previous fallthrough before a rollout change", async () => {
    const tools = await standalone("flag:web/production/new-checkout");
    const stub = serve((req) => (req.method === "GET" ? JSON.stringify(FLAG_DOC) : "{}"));
    await withToken(async () => {
      await tools.call("launchdarkly_flag_rollout_set", {
        ...FLAG,
        weights: [
          { variationId: "var-a", percent: 10 },
          { variationId: "var-b", percent: 90 },
        ],
      });
    });
    expect(stub.calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      `GET ${API}/flags/web/new-checkout?env=production`,
      `PATCH ${API}/flags/web/new-checkout`,
    ]);
    const executed = readFileSync(auditLog, "utf8")
      .trim()
      .split("\n")
      .map(
        (l) =>
          (JSON.parse(l) as { entry: { outcome: string; detail: Record<string, unknown> } }).entry,
      )
      .find((e) => e.outcome === "executed");
    expect(executed?.detail["preState"]).toMatchObject({
      fallthrough: { rollout: [{ weightPercent: 25 }, { weightPercent: 75 }] },
    });
  });

  it("is out of scope for another environment, with no request", async () => {
    const tools = await standalone("flag:web/staging/new-checkout");
    const stub = serve("{}");
    await withToken(async () => {
      expect(await tools.callJson("launchdarkly_flag_toggle", { ...FLAG, on: true })).toEqual({
        ok: false,
        error:
          "out of scope: flag:web/production/new-checkout is not in NIMBUS_MCP_LAUNCHDARKLY_WRITE_SCOPE",
      });
    });
    expect(stub.calls).toEqual([]);
  });
});
