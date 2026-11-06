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
import { registerFlagsmithTools } from "../src/tools.ts";

const FUTURE = "https://api.flagsmith.com/api/__future__";
const STATE_URL = `${FUTURE}/environments/ENVKEY123/features/42/`;
const ARGS = { environmentKey: "ENVKEY123", featureId: 42 };

let http: FetchStub | undefined;

function serve(reply: StubReply | ((req: RecordedRequest) => StubReply | undefined)): FetchStub {
  http?.restore();
  http = stubFetch(reply);
  return http;
}

const withToken = (fn: () => Promise<void>): Promise<void> =>
  withEnv({ FLAGSMITH_TOKEN: "fs-token", FLAGSMITH_API_BASE: undefined }, fn);

beforeEach(() => {
  resetConnectorModeForTests();
});

afterEach(() => {
  http?.restore();
  http = undefined;
  resetConnectorModeForTests();
});

describe("flagsmith feature state (gateway mode)", () => {
  let tools: CapturedTools;

  beforeEach(() => {
    setConnectorMode("gateway");
    tools = captureTools(registerFlagsmithTools);
  });

  const STATE = {
    environment_default: { enabled: true, value: { type: "integer", value: "1000" }, variants: [] },
    segment_overrides: [{ segment: { id: 1 } }],
  };

  it("get reads the __future__ endpoint with the same Token header the reads use", async () => {
    const stub = serve(JSON.stringify(STATE));
    await withToken(async () => {
      expect(await tools.callJson("flagsmith_feature_state_get", ARGS)).toEqual(STATE);
    });
    expect(`${stub.only.method} ${stub.only.url}`).toBe(`GET ${STATE_URL}`);
    expect(stub.only.headers["authorization"]).toBe("Token fs-token");
  });

  it("get caps segment overrides at 50 and discloses the rest", async () => {
    const many = Array.from({ length: 60 }, (_, i) => ({ id: i }));
    serve(JSON.stringify({ ...STATE, segment_overrides: many }));
    await withToken(async () => {
      const out = (await tools.callJson("flagsmith_feature_state_get", ARGS)) as {
        segment_overrides: unknown[];
        segmentOverridesNotShown: number;
      };
      expect(out.segment_overrides).toHaveLength(50);
      expect(out.segmentOverridesNotShown).toBe(10);
    });
  });

  it("get honours FLAGSMITH_API_BASE (self-hosted) without doubling the path", async () => {
    const stub = serve(JSON.stringify(STATE));
    await withEnv(
      { FLAGSMITH_TOKEN: "t", FLAGSMITH_API_BASE: "https://flags.internal.example" },
      async () => {
        await tools.call("flagsmith_feature_state_get", ARGS);
      },
    );
    expect(stub.only.url).toBe(
      "https://flags.internal.example/api/__future__/environments/ENVKEY123/features/42/",
    );
  });

  it("set with only enabled PATCHes just that, leaving the value out", async () => {
    const stub = serve('{"environment_default":{"enabled":false}}');
    await withToken(async () => {
      expect(
        await tools.callJson("flagsmith_feature_state_set", { ...ARGS, enabled: false }),
      ).toEqual({ ok: true, confirmed: true, ...ARGS, enabled: false });
    });
    expect(`${stub.only.method} ${stub.only.url}`).toBe(`PATCH ${STATE_URL}`);
    expect(stub.only.headers["content-type"]).toBe("application/json");
    expect(stub.only.headers["authorization"]).toBe("Token fs-token");
    expect(JSON.parse(stub.only.body ?? "null")).toEqual({
      environment_default: { enabled: false },
    });
  });

  it("set with a typed value sends the value as a string", async () => {
    const stub = serve("{}");
    await withToken(async () => {
      await tools.call("flagsmith_feature_state_set", {
        ...ARGS,
        enabled: true,
        value: { type: "integer", value: "-1000" },
      });
    });
    expect(JSON.parse(stub.only.body ?? "null")).toEqual({
      environment_default: { enabled: true, value: { type: "integer", value: "-1000" } },
    });
  });

  it("set refuses a value that does not match its type, sending nothing", async () => {
    const stub = serve("{}");
    await withToken(async () => {
      for (const value of [
        { type: "integer", value: "12.5" },
        { type: "integer", value: "1e3" },
        { type: "integer", value: "" },
        { type: "boolean", value: "yes" },
        { type: "boolean", value: "True" },
      ]) {
        await expect(
          tools.call("flagsmith_feature_state_set", { ...ARGS, enabled: true, value }),
        ).rejects.toThrow(/nothing was sent/);
      }
    });
    expect(stub.calls).toEqual([]);
  });

  it("set refuses an environment key or id that could reach another path", async () => {
    const stub = serve("{}");
    await withToken(async () => {
      for (const environmentKey of ["../x", "a/b", "a b", "", "a?b"]) {
        await expect(
          tools.call("flagsmith_feature_state_set", { ...ARGS, environmentKey, enabled: true }),
        ).rejects.toThrow();
      }
      await expect(
        tools.call("flagsmith_feature_state_set", { ...ARGS, featureId: 0, enabled: true }),
      ).rejects.toThrow();
    });
    expect(stub.calls).toEqual([]);
  });

  it("set reports confirmed:false when the reply echoes the opposite state or none", async () => {
    for (const reply of [
      '{"environment_default":{"enabled":false}}',
      "{}",
      '{"environment_default":{"enabled":"true"}}',
    ]) {
      serve(reply);
      await withToken(async () => {
        expect(
          await tools.callJson("flagsmith_feature_state_set", { ...ARGS, enabled: true }),
        ).toMatchObject({ ok: true, confirmed: false });
      });
    }
  });

  it("set with a value confirms only when the reply shows that value too", async () => {
    const value = { type: "integer", value: "42" };
    const cases: ReadonlyArray<readonly [string, boolean]> = [
      ['{"environment_default":{"enabled":true,"value":{"type":"integer","value":"42"}}}', true],
      ['{"environment_default":{"enabled":true,"value":{"type":"integer","value":42}}}', true],
      ['{"environment_default":{"enabled":true,"value":{"type":"integer","value":"7"}}}', false],
      ['{"environment_default":{"enabled":true,"value":{"type":"string","value":"42"}}}', false],
      ['{"environment_default":{"enabled":true}}', false],
    ];
    for (const [reply, confirmed] of cases) {
      serve(reply);
      await withToken(async () => {
        expect(
          await tools.callJson("flagsmith_feature_state_set", { ...ARGS, enabled: true, value }),
          reply,
        ).toMatchObject({ ok: true, confirmed });
      });
    }
  });

  it("states the PATCH merge semantics as unverified in its description", () => {
    expect(tools.get("flagsmith_feature_state_set").description).toMatch(
      /unverified against a live server/,
    );
  });

  it("quotes Flagsmith's refusal (change requests enabled)", async () => {
    serve({ status: 400, body: "change requests are enabled" });
    await withToken(async () => {
      await expect(
        tools.call("flagsmith_feature_state_set", { ...ARGS, enabled: true }),
      ).rejects.toThrow(/400.*change requests are enabled/);
    });
  });

  it("refuses a 307 to another origin and never follows it", async () => {
    const stub = serve({ status: 307, headers: { Location: "https://evil.test/steal" } });
    await withToken(async () => {
      await expect(
        tools.call("flagsmith_feature_state_set", { ...ARGS, enabled: true }),
      ).rejects.toThrow(/redirect/i);
    });
    expect(stub.calls).toHaveLength(1);
  });

  it("a read refuses a redirect to another origin, with the Token sent nowhere else", async () => {
    const stub = serve({ status: 302, headers: { Location: "https://evil.test/steal" } });
    await withToken(async () => {
      await expect(tools.call("flagsmith_feature_state_get", ARGS)).rejects.toThrow(
        /another origin/,
      );
    });
    expect(stub.calls.map((c) => c.url)).toEqual([STATE_URL]);
  });

  it("refuses without FLAGSMITH_TOKEN before any request", async () => {
    const stub = serve("{}");
    await withEnv({ FLAGSMITH_TOKEN: undefined }, async () => {
      await expect(
        tools.call("flagsmith_feature_state_set", { ...ARGS, enabled: true }),
      ).rejects.toThrow("FLAGSMITH_TOKEN is not set");
      await expect(tools.call("flagsmith_feature_state_get", ARGS)).rejects.toThrow(
        "FLAGSMITH_TOKEN is not set",
      );
    });
    expect(stub.calls).toEqual([]);
  });

  it("registers set with its fields visible (no refine)", () => {
    const schema = tools.get("flagsmith_feature_state_set").schema as { shape?: object };
    expect(Object.keys(schema.shape ?? {}).sort((a, b) => a.localeCompare(b))).toEqual([
      "enabled",
      "environmentKey",
      "featureId",
      "value",
    ]);
  });
});

describe("flagsmith feature state (standalone mode)", () => {
  let auditDir: string;
  let auditLog: string;

  beforeEach(() => {
    setConnectorMode("standalone");
    auditDir = mkdtempSync(join(tmpdir(), "nimbus-flagsmith-audit-"));
    auditLog = join(auditDir, "audit.jsonl");
  });

  afterEach(() => {
    rmSync(auditDir, { recursive: true, force: true });
  });

  async function standalone(scope: string): Promise<CapturedTools> {
    let tools: CapturedTools | undefined;
    await withEnv(
      {
        NIMBUS_MCP_FLAGSMITH_WRITE_SCOPE: scope,
        NIMBUS_MCP_AUDIT_LOG: auditLog,
        NIMBUS_MCP_WRITE_BUDGET: undefined,
      },
      () => {
        tools = captureStandaloneTools(registerFlagsmithTools, { elicitation: true }).tools;
      },
    );
    if (tools === undefined) throw new Error("registration did not run");
    return tools;
  }

  it("captures the previous state BEFORE the PATCH", async () => {
    const tools = await standalone("flag:ENVKEY123/42");
    const before = { environment_default: { enabled: true }, segment_overrides: [] };
    const stub = serve((req) => (req.method === "GET" ? JSON.stringify(before) : "{}"));
    await withToken(async () => {
      await tools.call("flagsmith_feature_state_set", { ...ARGS, enabled: false });
    });
    expect(stub.calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      `GET ${STATE_URL}`,
      `PATCH ${STATE_URL}`,
    ]);
    const executed = readFileSync(auditLog, "utf8")
      .trim()
      .split("\n")
      .map(
        (l) =>
          (JSON.parse(l) as { entry: { outcome: string; detail: Record<string, unknown> } }).entry,
      )
      .find((e) => e.outcome === "executed");
    expect(executed?.detail["preState"]).toEqual(before);
  });

  it("is out of scope for another feature, with no request", async () => {
    const tools = await standalone("flag:ENVKEY123/7");
    const stub = serve("{}");
    await withToken(async () => {
      expect(
        await tools.callJson("flagsmith_feature_state_set", { ...ARGS, enabled: true }),
      ).toEqual({
        ok: false,
        error: "out of scope: flag:ENVKEY123/42 is not in NIMBUS_MCP_FLAGSMITH_WRITE_SCOPE",
      });
    });
    expect(stub.calls).toEqual([]);
  });
});
