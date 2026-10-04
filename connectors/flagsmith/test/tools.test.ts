import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  type CapturedTools,
  captureTools,
  type FetchStub,
  type StubReply,
  stubFetch,
  withEnv,
} from "../../../scripts/connector-tool-harness.ts";
import { FLAGSMITH_TOOL_NAMES, registerFlagsmithTools } from "../src/tools.ts";

const API = "https://api.flagsmith.com/api/v1";

const FEATURES = [
  {
    id: 1,
    name: "new_checkout",
    description: "Rollout of the new checkout",
    tags: [7, "payments"],
  },
  { id: 2, name: "new_checkout_v2", description: "Next iteration", tags: [] },
  { id: 3, name: "dark_mode", description: "UI theme toggle", tags: ["ui"] },
];

let tools: CapturedTools;
let http: FetchStub | undefined;

function serve(reply: StubReply): FetchStub {
  http?.restore();
  http = stubFetch(reply);
  return http;
}

function configured(fn: () => Promise<void>): Promise<void> {
  return withEnv({ FLAGSMITH_TOKEN: "fs-token", FLAGSMITH_API_BASE: undefined }, fn);
}

beforeEach(() => {
  tools = captureTools(registerFlagsmithTools);
});

afterEach(() => {
  http?.restore();
  http = undefined;
});

describe("flagsmith tools", () => {
  it("registers exactly FLAGSMITH_TOOL_NAMES, in order", () => {
    expect(tools.registrationOrder()).toEqual([...FLAGSMITH_TOOL_NAMES]);
  });

  it("list with no project lists projects, authenticating with the Token scheme", async () => {
    const stub = serve('[{"id":1,"name":"web"}]');
    await configured(async () => {
      expect(await tools.callJson("flagsmith_list", {})).toEqual([{ id: 1, name: "web" }]);
    });
    expect(stub.only.url).toBe(`${API}/projects/`);
    expect(stub.only.headers["authorization"]).toBe("Token fs-token");
  });

  it("list with a project lists its features, 100 per page unless limited", async () => {
    const stub = serve('{"results":[]}');
    await configured(async () => {
      await tools.call("flagsmith_list", { projectId: 12 });
    });
    expect(stub.only.url).toBe(`${API}/projects/12/features/?page_size=100`);

    const limited = serve('{"results":[]}');
    await configured(async () => {
      await tools.call("flagsmith_list", { projectId: 12, limit: 3 });
    });
    expect(limited.only.url).toBe(`${API}/projects/12/features/?page_size=3`);
  });

  it("honours a self-hosted FLAGSMITH_API_BASE", async () => {
    const stub = serve("[]");
    await withEnv(
      { FLAGSMITH_TOKEN: "t", FLAGSMITH_API_BASE: "https://flags.internal.example" },
      async () => {
        await tools.call("flagsmith_list", {});
      },
    );
    expect(stub.only.url).toBe("https://flags.internal.example/api/v1/projects/");
  });

  it("get narrows a name search to the EXACT name, from a paged or bare-array answer", async () => {
    for (const body of [{ results: FEATURES }, FEATURES]) {
      const stub = serve(JSON.stringify(body));
      await configured(async () => {
        // "new_checkout" is a substring of "new_checkout_v2" too: only the exact one is returned.
        expect(
          await tools.callJson("flagsmith_get", { projectId: 12, featureName: "new_checkout" }),
        ).toEqual(FEATURES[0]);
      });
      expect(Object.fromEntries(new URL(stub.only.url).searchParams)).toEqual({
        page_size: "100",
        search: "new_checkout",
      });
    }
  });

  it("get throws when no feature has exactly that name", async () => {
    for (const body of [{ results: FEATURES }, { results: [null, "x"] }, { detail: "nope" }]) {
      serve(JSON.stringify(body));
      await configured(async () => {
        await expect(
          tools.call("flagsmith_get", { projectId: 12, featureName: "new" }),
        ).rejects.toThrow("Flagsmith feature not found: new");
      });
    }
  });

  it("search matches name, description and tags across up to 500 features", async () => {
    const stub = serve(JSON.stringify({ results: FEATURES }));
    const ids = async (query: string, limit?: number): Promise<unknown[]> => {
      let out: unknown;
      await configured(async () => {
        out = await tools.callJson("flagsmith_search", {
          projectId: 12,
          query,
          ...(limit === undefined ? {} : { limit }),
        });
      });
      return (out as { matches: { id: number }[] }).matches.map((m) => m.id);
    };
    expect(await ids("NEW_CHECKOUT")).toEqual([1, 2]);
    expect(await ids("theme")).toEqual([3]);
    expect(await ids("payments")).toEqual([1]);
    expect(await ids("new", 1)).toEqual([1]);
    expect(stub.calls[0]?.url).toBe(`${API}/projects/12/features/?page_size=500`);
  });

  it("surfaces a failed request with its status and body", async () => {
    serve({ status: 401, body: "Invalid token." });
    await configured(async () => {
      await expect(tools.call("flagsmith_search", { projectId: 1, query: "x" })).rejects.toThrow(
        "Flagsmith 401: Invalid token.",
      );
    });
  });
});
