import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  type CapturedTools,
  captureTools,
  type FetchStub,
  type StubReply,
  stubFetch,
  withEnv,
} from "../../../scripts/connector-tool-harness.ts";
import { BITRISE_TOOL_NAMES, registerBitriseTools } from "../src/tools.ts";

const API = "https://api.bitrise.io/v0.1";

const BUILDS = {
  data: [
    {
      slug: "b1",
      branch: "main",
      commit_message: "Bump version",
      triggered_workflow: "release",
      status_text: "success",
    },
    {
      slug: "b2",
      branch: "feature/login",
      commit_message: "Add OAuth login",
      triggered_workflow: "pr-check",
      status_text: "error",
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

/** Call `name` with the token set; return the one request's URL. */
async function urlOf(name: string, args: Record<string, unknown>): Promise<string> {
  const stub = serve("{}");
  await withEnv({ BITRISE_TOKEN: "bitrise-pat" }, async () => {
    await tools.call(name, args);
  });
  return stub.only.url;
}

beforeEach(() => {
  tools = captureTools(registerBitriseTools);
});

afterEach(() => {
  http?.restore();
  http = undefined;
});

describe("bitrise tools", () => {
  it("registers exactly BITRISE_TOOL_NAMES", () => {
    expect(tools.names()).toEqual([...BITRISE_TOOL_NAMES]);
  });

  it("list with no app lists the user's apps, sending the token with no scheme", async () => {
    const stub = serve('{"data":[]}');
    await withEnv({ BITRISE_TOKEN: "bitrise-pat" }, async () => {
      expect(await tools.callJson("bitrise_list", {})).toEqual({ data: [] });
    });
    expect(stub.only.url).toBe(`${API}/me/apps?limit=50`);
    expect(stub.only.headers["authorization"]).toBe("bitrise-pat");
    expect(await urlOf("bitrise_list", { limit: 5 })).toBe(`${API}/me/apps?limit=5`);
  });

  it("list with an app lists its builds, 50 by default", async () => {
    expect(await urlOf("bitrise_list", { appSlug: "app/1" })).toBe(
      `${API}/apps/app%2F1/builds?limit=50`,
    );
  });

  it("list maps each build status filter to Bitrise's numeric code", async () => {
    for (const [status, code] of [
      ["not-finished", 0],
      ["successful", 1],
      ["failed", 2],
      ["aborted", 3],
    ] as const) {
      expect(await urlOf("bitrise_list", { appSlug: "a", status, limit: 10 })).toBe(
        `${API}/apps/a/builds?limit=10&status=${String(code)}`,
      );
    }
  });

  it("get returns the app, or one of its builds", async () => {
    expect(await urlOf("bitrise_get", { appSlug: "a 1" })).toBe(`${API}/apps/a%201`);
    expect(await urlOf("bitrise_get", { appSlug: "a", buildSlug: "b/2" })).toBe(
      `${API}/apps/a/builds/b%2F2`,
    );
  });

  it("search matches recent builds by branch, commit message, workflow and status", async () => {
    const stub = serve(JSON.stringify(BUILDS));
    const slugs = async (query: string, limit?: number): Promise<unknown[]> => {
      let out: unknown;
      await withEnv({ BITRISE_TOKEN: "t" }, async () => {
        out = await tools.callJson("bitrise_search", {
          appSlug: "a",
          query,
          ...(limit === undefined ? {} : { limit }),
        });
      });
      return (out as { matches: { slug: string }[] }).matches.map((m) => m.slug);
    };
    expect(await slugs("FEATURE/")).toEqual(["b2"]);
    expect(await slugs("bump")).toEqual(["b1"]);
    expect(await slugs("pr-check")).toEqual(["b2"]);
    expect(await slugs("SUCCESS")).toEqual(["b1"]);
    expect(await slugs("o", 1)).toHaveLength(1);
    expect(stub.calls[0]?.url).toBe(`${API}/apps/a/builds?limit=50`);
  });

  it("search returns no matches when the answer carries no data array", async () => {
    serve('{"message":"not found"}');
    await withEnv({ BITRISE_TOKEN: "t" }, async () => {
      expect(await tools.callJson("bitrise_search", { appSlug: "a", query: "x" })).toEqual({
        matches: [],
      });
    });
  });

  it("refuses without BITRISE_TOKEN, before any request, and surfaces API errors", async () => {
    const stub = serve("{}");
    await withEnv({ BITRISE_TOKEN: undefined }, async () => {
      await expect(tools.call("bitrise_list", {})).rejects.toThrow("BITRISE_TOKEN is not set");
    });
    expect(stub.calls).toEqual([]);

    serve({ status: 404, body: "App not found" });
    await withEnv({ BITRISE_TOKEN: "t" }, async () => {
      await expect(tools.call("bitrise_get", { appSlug: "x" })).rejects.toThrow(
        "Bitrise 404: App not found",
      );
    });
  });
});
