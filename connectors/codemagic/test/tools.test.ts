import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  type CapturedTools,
  captureTools,
  type FetchStub,
  type StubReply,
  stubFetch,
  withEnv,
} from "../../../scripts/connector-tool-harness.ts";
import { CODEMAGIC_TOOL_NAMES, registerCodemagicTools } from "../src/tools.ts";

const API = "https://api.codemagic.io";

const BUILDS = {
  builds: [
    {
      _id: "b1",
      branch: "main",
      message: "Release 2.0",
      workflowId: "ios-release",
      status: "finished",
    },
    {
      _id: "b2",
      branch: "fix/crash",
      message: "Fix crash",
      workflowId: "pr-checks",
      status: "failed",
    },
  ],
};

let tools: CapturedTools;
let http: FetchStub | undefined;

function serve(reply: StubReply): FetchStub {
  http?.restore();
  http = stubFetch(reply);
  return http;
}

function configured(fn: () => Promise<void>): Promise<void> {
  return withEnv({ CODEMAGIC_TOKEN: "cm-token" }, fn);
}

beforeEach(() => {
  tools = captureTools(registerCodemagicTools);
});

afterEach(() => {
  http?.restore();
  http = undefined;
});

describe("codemagic tools", () => {
  it("registers exactly CODEMAGIC_TOOL_NAMES, in order", () => {
    expect(tools.registrationOrder()).toEqual([...CODEMAGIC_TOOL_NAMES]);
  });

  it("list with no app lists the apps, sending the token in x-auth-token", async () => {
    const stub = serve('{"applications":[]}');
    await configured(async () => {
      expect(await tools.callJson("codemagic_list", {})).toEqual({ applications: [] });
    });
    expect(stub.only.url).toBe(`${API}/apps`);
    expect(stub.only.headers["x-auth-token"]).toBe("cm-token");
    expect(stub.only.headers["authorization"]).toBeUndefined();
  });

  it("list with an app lists its builds, 50 by default and `limit` when given", async () => {
    const byDefault = serve('{"builds":[]}');
    await configured(async () => {
      await tools.call("codemagic_list", { appId: "app 1" });
    });
    expect(byDefault.only.url).toBe(`${API}/builds?appId=app%201&limit=50`);

    const limited = serve('{"builds":[]}');
    await configured(async () => {
      await tools.call("codemagic_list", { appId: "a", limit: 3 });
    });
    expect(limited.only.url).toBe(`${API}/builds?appId=a&limit=3`);
  });

  it("get returns the apps without a build id, and the one build with it", async () => {
    const apps = serve('{"applications":[]}');
    await configured(async () => {
      await tools.call("codemagic_get", { appId: "a" });
    });
    expect(apps.only.url).toBe(`${API}/apps`);

    const build = serve('{"build":{"_id":"b/1"}}');
    await configured(async () => {
      expect(await tools.callJson("codemagic_get", { appId: "a", buildId: "b/1" })).toEqual({
        build: { _id: "b/1" },
      });
    });
    expect(build.only.url).toBe(`${API}/builds/b%2F1`);
  });

  it("search matches an app's builds by branch, message, workflow and status", async () => {
    const stub = serve(JSON.stringify(BUILDS));
    const ids = async (query: string, limit?: number): Promise<unknown[]> => {
      let out: unknown;
      await configured(async () => {
        out = await tools.callJson("codemagic_search", {
          appId: "a",
          query,
          ...(limit === undefined ? {} : { limit }),
        });
      });
      return (out as { matches: { _id: string }[] }).matches.map((m) => m._id);
    };
    expect(await ids("FIX/")).toEqual(["b2"]);
    expect(await ids("release 2")).toEqual(["b1"]);
    expect(await ids("pr-checks")).toEqual(["b2"]);
    expect(await ids("FAILED")).toEqual(["b2"]);
    expect(await ids("i", 1)).toEqual(["b1"]);
    expect(stub.calls[0]?.url).toBe(`${API}/builds?appId=a&limit=50`);
  });

  it("search finds nothing when the answer carries no builds array", async () => {
    serve('{"error":"no app"}');
    await configured(async () => {
      expect(await tools.callJson("codemagic_search", { appId: "a", query: "x" })).toEqual({
        matches: [],
      });
    });
  });

  it("refuses without CODEMAGIC_TOKEN, before any request, and quotes an API failure", async () => {
    const stub = serve("{}");
    await withEnv({ CODEMAGIC_TOKEN: undefined }, async () => {
      await expect(tools.call("codemagic_list", {})).rejects.toThrow("CODEMAGIC_TOKEN is not set");
    });
    expect(stub.calls).toEqual([]);

    serve({ status: 401, body: "Invalid token" });
    await configured(async () => {
      await expect(tools.call("codemagic_get", { appId: "a", buildId: "b" })).rejects.toThrow(
        "Codemagic 401: Invalid token",
      );
    });
  });
});
