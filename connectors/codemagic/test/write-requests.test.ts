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
import { registerCodemagicTools } from "../src/tools.ts";

const API = "https://api.codemagic.io";
const ARGS = { appId: "app_1", workflowId: "ios-release", branch: "main" };

let tools: CapturedTools;
let http: FetchStub | undefined;

function serve(reply: StubReply): FetchStub {
  http?.restore();
  http = stubFetch(reply);
  return http;
}

const withToken = (fn: () => Promise<void>): Promise<void> =>
  withEnv({ CODEMAGIC_TOKEN: "cm-token" }, fn);

beforeEach(() => {
  setConnectorMode("gateway");
  tools = captureTools(registerCodemagicTools);
});

afterEach(() => {
  http?.restore();
  http = undefined;
  resetConnectorModeForTests();
});

describe("codemagic_build_trigger (gateway mode)", () => {
  it("POSTs appId, workflowId and branch with x-auth-token", async () => {
    const stub = serve('{"buildId":"bld_7"}');
    let result: unknown;
    await withToken(async () => {
      result = await tools.callJson("codemagic_build_trigger", ARGS);
    });
    const req = stub.only;
    expect(`${req.method} ${req.url}`).toBe(`POST ${API}/builds`);
    expect(req.headers["x-auth-token"]).toBe("cm-token");
    expect(req.headers["authorization"]).toBeUndefined();
    expect(req.headers["content-type"]).toBe("application/json");
    expect(JSON.parse(req.body ?? "null")).toEqual(ARGS);
    expect(result).toEqual({
      ok: true,
      status: "accepted",
      appId: "app_1",
      workflowId: "ios-release",
      branch: "main",
      buildId: "bld_7",
    });
  });

  it("reports buildId: null when the reply has none, and never claims completion", async () => {
    serve("{}");
    await withToken(async () => {
      const out = await tools.callJson("codemagic_build_trigger", ARGS);
      expect(out).toMatchObject({ status: "accepted", buildId: null });
      expect(JSON.stringify(out)).not.toMatch(/deployed|done|completed/i);
    });
  });

  it("refuses a 307 and sends no second request", async () => {
    const stub = serve({ status: 307, headers: { Location: "https://evil.test/steal" } });
    await withToken(async () => {
      await expect(tools.call("codemagic_build_trigger", ARGS)).rejects.toThrow(/redirect/i);
    });
    expect(stub.calls).toHaveLength(1);
    expect(stub.only.redirect).toBe("manual");
  });

  it("refuses ids and branches that could reach another place, before any request", async () => {
    const stub = serve("{}");
    await withToken(async () => {
      for (const bad of ["../x", "a/b", "a b", "", ".", ".."]) {
        await expect(
          tools.call("codemagic_build_trigger", { ...ARGS, appId: bad }),
        ).rejects.toThrow();
        await expect(
          tools.call("codemagic_build_trigger", { ...ARGS, workflowId: bad }),
        ).rejects.toThrow();
      }
      for (const bad of ["../x", "-x", "a b", "a..b", "x.lock"]) {
        await expect(
          tools.call("codemagic_build_trigger", { ...ARGS, branch: bad }),
        ).rejects.toThrow();
      }
    });
    expect(stub.calls).toEqual([]);
  });

  it("refuses without CODEMAGIC_TOKEN before any request", async () => {
    const stub = serve("{}");
    await withEnv({ CODEMAGIC_TOKEN: undefined }, async () => {
      await expect(tools.call("codemagic_build_trigger", ARGS)).rejects.toThrow(
        "CODEMAGIC_TOKEN is not set",
      );
    });
    expect(stub.calls).toEqual([]);
  });

  it("surfaces an API refusal", async () => {
    serve({ status: 400, body: "unknown workflow" });
    await withToken(async () => {
      await expect(tools.call("codemagic_build_trigger", ARGS)).rejects.toThrow(
        /400.*unknown workflow/,
      );
    });
  });
});

describe("codemagic_build_latest", () => {
  const BUILDS = {
    builds: [
      { _id: "b3", workflowId: "android", branch: "main", status: "finished" },
      { _id: "b2", workflowId: "ios-release", branch: "dev", status: "building" },
      { _id: "b1", workflowId: "ios-release", branch: "main", status: "finished" },
    ],
  };

  it("filters the app's builds by workflow and branch, newest first", async () => {
    const stub = serve(JSON.stringify(BUILDS));
    await withToken(async () => {
      expect(await tools.callJson("codemagic_build_latest", ARGS)).toEqual({
        build: BUILDS.builds[2],
        scanned: 3,
      });
      expect(
        await tools.callJson("codemagic_build_latest", { appId: "app_1", branch: "dev" }),
      ).toMatchObject({ build: { _id: "b2" } });
      expect(await tools.callJson("codemagic_build_latest", { appId: "app_1" })).toMatchObject({
        build: { _id: "b3" },
      });
    });
    expect(stub.calls[0]?.url).toBe(`${API}/builds?appId=app_1&limit=50`);
  });

  it("returns build: null when nothing matches", async () => {
    serve(JSON.stringify(BUILDS));
    await withToken(async () => {
      expect(
        await tools.callJson("codemagic_build_latest", { appId: "app_1", branch: "nope" }),
      ).toEqual({ build: null, scanned: 3 });
    });
  });
});
