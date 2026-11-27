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
import { registerSplitTools, SPLIT_TOOL_NAMES } from "../src/tools.ts";

const API = "https://api.split.io/internal/api/v2";
const KEY = "fake-split-admin-key";
const DEF_URL = `${API}/splits/ws/ws-1234/new_checkout/environments/Production`;
const ARGS = { workspaceId: "ws-1234", splitName: "new_checkout", environment: "Production" };

const WRITES = [
  {
    tool: "split_kill",
    verb: "kill",
    killed: true,
    comment: "Killed by Nimbus after owner approval",
  },
  {
    tool: "split_restore",
    verb: "restore",
    killed: false,
    comment: "Restored by Nimbus after owner approval",
  },
] as const;

let http: FetchStub | undefined;

function serve(reply: StubReply | ((req: RecordedRequest) => StubReply | undefined)): FetchStub {
  http?.restore();
  http = stubFetch(reply);
  return http;
}

const configured = (fn: () => Promise<void>): Promise<void> =>
  withEnv({ SPLIT_ADMIN_API_KEY: KEY }, fn);

/** The write answers 200 with no body; the definition read after it answers `killed`. */
const answered =
  (killed: boolean) =>
  (req: RecordedRequest): StubReply =>
    req.method === "PUT" ? { status: 200, body: "" } : JSON.stringify({ killed });

beforeEach(() => {
  resetConnectorModeForTests();
});

afterEach(() => {
  http?.restore();
  http = undefined;
  resetConnectorModeForTests();
});

describe("split kill and restore (gateway mode)", () => {
  let tools: CapturedTools;

  beforeEach(() => {
    setConnectorMode("gateway");
    tools = captureTools(registerSplitTools);
  });

  for (const w of WRITES) {
    it(`${w.tool} PUTs .../${w.verb} with a comment, then reads the definition back`, async () => {
      const stub = serve(answered(w.killed));
      await configured(async () => {
        expect(await tools.callJson(w.tool, ARGS)).toEqual({
          ok: true,
          ...ARGS,
          confirmed: true,
          killed: w.killed,
        });
      });
      expect(stub.calls.map((c) => `${c.method} ${c.url}`)).toEqual([
        `PUT ${DEF_URL}/${w.verb}`,
        `GET ${DEF_URL}`,
      ]);
      const put = stub.calls[0];
      expect(put?.headers["authorization"]).toBe(`Bearer ${KEY}`);
      expect(put?.headers["content-type"]).toBe("application/json");
      expect(JSON.parse(put?.body ?? "null")).toEqual({ comment: w.comment });
      expect(put?.redirect).toBe("manual");
    });

    it(`${w.tool} reports confirmed:false when the read-back shows the other state`, async () => {
      serve(answered(!w.killed));
      await configured(async () => {
        expect(await tools.callJson(w.tool, ARGS)).toMatchObject({
          ok: true,
          confirmed: false,
          killed: !w.killed,
        });
      });
    });

    it(`${w.tool} reports the write done, unconfirmed, when the read-back fails`, async () => {
      serve((req) =>
        req.method === "PUT" ? { status: 200, body: "" } : { status: 503, body: "busy" },
      );
      await configured(async () => {
        expect(await tools.callJson(w.tool, ARGS)).toMatchObject({
          ok: true,
          confirmed: false,
          confirmError: expect.stringMatching(/503/),
        });
      });
    });

    it(`${w.tool} refuses a dot segment or path character, sending nothing`, async () => {
      const stub = serve("{}");
      await configured(async () => {
        for (const key of ["workspaceId", "splitName", "environment"] as const) {
          // An inner space is allowed in the environment only (tested below), so " a" stands in.
          for (const bad of [
            "..",
            ".",
            "a/b",
            "a?b",
            "a#b",
            key === "environment" ? " a" : "a b",
            "",
          ]) {
            await expect(tools.call(w.tool, { ...ARGS, [key]: bad })).rejects.toThrow(
              /letters, digits/,
            );
          }
        }
      });
      expect(stub.calls).toEqual([]);
    });

    it(`${w.tool} refuses a redirect and never follows it`, async () => {
      const stub = serve({ status: 308, headers: { Location: "https://evil.test/steal" } });
      await configured(async () => {
        await expect(tools.call(w.tool, ARGS)).rejects.toThrow(
          /redirect \(308\); the write may or may not have been applied/,
        );
      });
      expect(stub.calls).toHaveLength(1);
    });

    it(`${w.tool} quotes Split's refusal with its status, bounded and without the key`, async () => {
      serve({
        status: 403,
        body: `{"code":403,"message":"Failed to ${w.verb}"}${"y".repeat(900)}`,
      });
      await configured(async () => {
        const err = await tools.call(w.tool, ARGS).then(
          () => undefined,
          (e: unknown) => e as Error,
        );
        expect(err?.message).toContain(
          `Split PUT /splits/ws/ws-1234/new_checkout/environments/Production/${w.verb} 403: {"code":403`,
        );
        expect(err?.message.length).toBeLessThan(600);
        expect(err?.message).not.toContain(KEY);
      });
    });

    it(`${w.tool} refuses without SPLIT_ADMIN_API_KEY before any request`, async () => {
      const stub = serve("{}");
      await withEnv({ SPLIT_ADMIN_API_KEY: undefined }, async () => {
        await expect(tools.call(w.tool, ARGS)).rejects.toThrow("SPLIT_ADMIN_API_KEY is not set");
      });
      expect(stub.calls).toEqual([]);
    });
  }
});

describe("split kill and restore (standalone mode)", () => {
  beforeEach(() => {
    setConnectorMode("standalone");
  });

  it("both are writes: listed only to a client that can ask a human", async () => {
    const writes: readonly string[] = WRITES.map((w) => w.tool);
    const reads = SPLIT_TOOL_NAMES.filter((n) => !writes.includes(n));
    await withEnv({ NIMBUS_MCP_SPLIT_WRITE_SCOPE: "flag:ws-1234/Production/new_checkout" }, () => {
      const blind = captureStandaloneTools(registerSplitTools, { elicitation: false }).tools;
      expect(blind.names()).toEqual([...reads].sort((a, b) => a.localeCompare(b)));
      const asking = captureStandaloneTools(registerSplitTools, { elicitation: true }).tools;
      expect(asking.names()).toEqual([...SPLIT_TOOL_NAMES].sort((a, b) => a.localeCompare(b)));
    });
  });

  for (const w of WRITES) {
    it(`${w.tool} runs approved and in scope`, async () => {
      const stub = serve(answered(w.killed));
      await configured(async () => {
        const run = await approvedStandaloneWrite(
          registerSplitTools,
          { NIMBUS_MCP_SPLIT_WRITE_SCOPE: "flag:ws-1234/Production/new_checkout" },
          w.tool,
          ARGS,
        );
        expect(run.answer).toMatchObject({ ok: true, confirmed: true, killed: w.killed });
        expect(run.chain.ok).toBe(true);
        expect(run.audit.map((e) => e.outcome)).toContain("executed");
      });
      expect(stub.calls.map((c) => c.method)).toEqual(["PUT", "GET"]);
    });

    it(`${w.tool} takes an environment name with a space, scoped by that exact name`, async () => {
      const spaced = { ...ARGS, environment: "Production EU" };
      const stub = serve(answered(w.killed));
      await configured(async () => {
        const run = await approvedStandaloneWrite(
          registerSplitTools,
          { NIMBUS_MCP_SPLIT_WRITE_SCOPE: "flag:ws-1234/Production EU/new_checkout" },
          w.tool,
          spaced,
        );
        expect(run.answer).toMatchObject({
          ok: true,
          confirmed: true,
          environment: "Production EU",
        });
      });
      expect(stub.calls.map((c) => `${c.method} ${c.url}`)).toEqual([
        `PUT ${API}/splits/ws/ws-1234/new_checkout/environments/Production%20EU/${w.verb}`,
        `GET ${API}/splits/ws/ws-1234/new_checkout/environments/Production%20EU`,
      ]);
    });

    it(`${w.tool} with "Production EU" is out of a scope naming only "Production"`, async () => {
      const stub = serve("{}");
      await configured(async () => {
        const run = await approvedStandaloneWrite(
          registerSplitTools,
          { NIMBUS_MCP_SPLIT_WRITE_SCOPE: "flag:ws-1234/Production/new_checkout" },
          w.tool,
          { ...ARGS, environment: "Production EU" },
        );
        expect(run.answer).toEqual({
          ok: false,
          error:
            "out of scope: flag:ws-1234/Production EU/new_checkout is not in NIMBUS_MCP_SPLIT_WRITE_SCOPE",
        });
      });
      expect(stub.calls).toEqual([]);
    });
  }
});

describe("split environment argument", () => {
  let tools: CapturedTools;

  beforeEach(() => {
    setConnectorMode("gateway");
    tools = captureTools(registerSplitTools);
  });

  it("accepts single inner spaces in the environment, and nowhere else", async () => {
    const stub = serve(answered(true));
    await configured(async () => {
      await tools.call("split_kill", { ...ARGS, environment: "Prod EU West-1" });
      await expect(
        tools.call("split_kill", { ...ARGS, splitName: "new checkout" }),
      ).rejects.toThrow(/letters, digits/);
      await expect(tools.call("split_kill", { ...ARGS, workspaceId: "ws 1234" })).rejects.toThrow(
        /letters, digits/,
      );
    });
    expect(stub.calls[0]?.url).toContain("/environments/Prod%20EU%20West-1/kill");
  });

  it("refuses a hostile or malformed environment, sending nothing", async () => {
    const stub = serve("{}");
    await configured(async () => {
      for (const bad of [
        " Production",
        "Production ",
        "Production  EU",
        ".",
        "..",
        "a/b",
        "a\\b",
        "a%2Fb",
        "a?b",
        "a#b",
        "a@b",
        "a:b",
        "a\tb",
        "a\nb",
        "a\u0000b",
        "",
        "x".repeat(129),
      ]) {
        await expect(
          tools.call("split_definition_get", { ...ARGS, environment: bad }),
          JSON.stringify(bad),
        ).rejects.toThrow(/letters, digits/);
      }
    });
    expect(stub.calls).toEqual([]);
  });
});
