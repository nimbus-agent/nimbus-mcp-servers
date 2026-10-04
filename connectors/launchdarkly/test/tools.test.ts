import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  type CapturedTools,
  captureTools,
  type FetchStub,
  type StubReply,
  stubFetch,
  withEnv,
} from "../../../scripts/connector-tool-harness.ts";
import { LAUNCHDARKLY_TOOL_NAMES, registerLaunchdarklyTools } from "../src/tools.ts";

const API = "https://app.launchdarkly.com/api/v2";

const FLAGS = {
  items: [
    {
      key: "new-checkout",
      name: "New checkout",
      description: "Checkout v2",
      tags: ["payments", 3],
    },
    { key: "dark-mode", name: "Dark mode", description: "Theme toggle", tags: "legacy-tag" },
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
  return withEnv({ LAUNCHDARKLY_TOKEN: "api-ld", LAUNCHDARKLY_BASE_URL: undefined }, fn);
}

beforeEach(() => {
  tools = captureTools(registerLaunchdarklyTools);
});

afterEach(() => {
  http?.restore();
  http = undefined;
});

describe("launchdarkly tools", () => {
  it("registers exactly LAUNCHDARKLY_TOOL_NAMES, in order", () => {
    expect(tools.registrationOrder()).toEqual([...LAUNCHDARKLY_TOOL_NAMES]);
  });

  it("list with no project lists projects, sending the bare token", async () => {
    const stub = serve('{"items":[{"key":"web"}]}');
    await configured(async () => {
      expect(await tools.callJson("launchdarkly_list", {})).toEqual({ items: [{ key: "web" }] });
    });
    expect(stub.only.url).toBe(`${API}/projects`);
    expect(stub.only.headers["authorization"]).toBe("api-ld");
  });

  it("list with a project lists its flags in summary form, 100 by default", async () => {
    const byDefault = serve('{"items":[]}');
    await configured(async () => {
      await tools.call("launchdarkly_list", { projectKey: "web app" });
    });
    expect(byDefault.only.url).toBe(`${API}/flags/web%20app?summary=true&limit=100`);

    const limited = serve('{"items":[]}');
    await configured(async () => {
      await tools.call("launchdarkly_list", { projectKey: "web", limit: 7 });
    });
    expect(limited.only.url).toBe(`${API}/flags/web?summary=true&limit=7`);
  });

  it("get fetches one flag of one project", async () => {
    const stub = serve('{"key":"new-checkout"}');
    await configured(async () => {
      expect(
        await tools.callJson("launchdarkly_get", { projectKey: "web", flagKey: "new/checkout" }),
      ).toEqual({ key: "new-checkout" });
    });
    expect(stub.only.url).toBe(`${API}/flags/web/new%2Fcheckout`);
  });

  it("talks to the configured base URL, keeping it as given", async () => {
    const stub = serve('{"items":[]}');
    await withEnv(
      { LAUNCHDARKLY_TOKEN: "t", LAUNCHDARKLY_BASE_URL: "https://ld.internal.example" },
      async () => {
        await tools.call("launchdarkly_list", {});
      },
    );
    expect(stub.only.url).toBe("https://ld.internal.example/api/v2/projects");
  });

  it("search matches flags by key, name, description and string tags", async () => {
    const stub = serve(JSON.stringify(FLAGS));
    const keys = async (query: string, limit?: number): Promise<unknown[]> => {
      let out: unknown;
      await configured(async () => {
        out = await tools.callJson("launchdarkly_search", {
          projectKey: "web",
          query,
          ...(limit === undefined ? {} : { limit }),
        });
      });
      return (out as { matches: { key: string }[] }).matches.map((m) => m.key);
    };
    expect(await keys("NEW-CHECKOUT")).toEqual(["new-checkout"]);
    expect(await keys("dark mode")).toEqual(["dark-mode"]);
    expect(await keys("THEME toggle")).toEqual(["dark-mode"]);
    expect(await keys("payments")).toEqual(["new-checkout"]);
    // A `tags` value that is not an array contributes nothing to the match.
    expect(await keys("legacy-tag")).toEqual([]);
    expect(await keys("e", 1)).toEqual(["new-checkout"]);
    expect(stub.calls[0]?.url).toBe(`${API}/flags/web?summary=true&limit=500`);
  });

  it("search finds nothing when the answer carries no items array", async () => {
    serve('{"code":"not_found"}');
    await configured(async () => {
      expect(
        await tools.callJson("launchdarkly_search", { projectKey: "web", query: "x" }),
      ).toEqual({ matches: [] });
    });
  });

  it("refuses without LAUNCHDARKLY_TOKEN, before any request, and quotes an API failure", async () => {
    const stub = serve("{}");
    await withEnv({ LAUNCHDARKLY_TOKEN: undefined }, async () => {
      await expect(tools.call("launchdarkly_list", {})).rejects.toThrow(
        "LAUNCHDARKLY_TOKEN is not set",
      );
    });
    expect(stub.calls).toEqual([]);

    serve({ status: 403, body: "Forbidden" });
    await configured(async () => {
      await expect(
        tools.call("launchdarkly_get", { projectKey: "web", flagKey: "x" }),
      ).rejects.toThrow("LaunchDarkly 403: Forbidden");
    });
  });
});
