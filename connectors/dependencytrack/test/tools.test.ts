import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  byToolName,
  type CapturedTools,
  captureTools,
  type FetchStub,
  type StubReply,
  stubFetch,
  withEnv,
} from "../../../scripts/connector-tool-harness.ts";
import { DEPENDENCYTRACK_TOOL_NAMES, registerDependencytrackTools } from "../src/tools.ts";

const BASE = "https://dtrack.example.com";

const PROJECTS = [
  { uuid: "p-1", name: "web-shop", version: "2.4.0", classifier: "APPLICATION", tags: [] },
  {
    uuid: "p-2",
    name: "auth-lib",
    version: "1.0.3",
    classifier: "LIBRARY",
    tags: [{ name: "pci" }],
  },
];

let tools: CapturedTools;
let http: FetchStub | undefined;

function serve(reply: StubReply): FetchStub {
  http?.restore();
  http = stubFetch(reply);
  return http;
}

function configured(fn: () => Promise<void>): Promise<void> {
  return withEnv({ DEPENDENCYTRACK_URL: BASE, DEPENDENCYTRACK_API_KEY: "odt_key" }, fn);
}

beforeEach(() => {
  tools = captureTools(registerDependencytrackTools);
});

afterEach(() => {
  http?.restore();
  http = undefined;
});

describe("dependencytrack tools", () => {
  it("registers exactly DEPENDENCYTRACK_TOOL_NAMES", () => {
    expect(tools.names()).toEqual([...DEPENDENCYTRACK_TOOL_NAMES].sort(byToolName));
  });

  it("list reads page 1 by default and `pageNumber` when given, with a bare X-Api-Key", async () => {
    const stub = serve(JSON.stringify(PROJECTS));
    await configured(async () => {
      expect(await tools.callJson("dependencytrack_list", {})).toEqual({ items: PROJECTS });
      await tools.call("dependencytrack_list", { pageNumber: 3 });
    });
    expect(stub.calls.map((c) => c.url)).toEqual([
      `${BASE}/api/v1/project?pageSize=100&pageNumber=1&excludeInactive=false`,
      `${BASE}/api/v1/project?pageSize=100&pageNumber=3&excludeInactive=false`,
    ]);
    expect(stub.calls[0]?.headers["x-api-key"]).toBe("odt_key");
    expect(stub.calls[0]?.headers["authorization"]).toBeUndefined();
  });

  it("list returns no items when the answer is not an array", async () => {
    serve('{"message":"unexpected"}');
    await configured(async () => {
      expect(await tools.callJson("dependencytrack_list", {})).toEqual({ items: [] });
    });
  });

  it("get fetches one project by its encoded uuid", async () => {
    const stub = serve('{"uuid":"p-1"}');
    await configured(async () => {
      expect(await tools.callJson("dependencytrack_get", { uuid: "p 1" })).toEqual({
        uuid: "p-1",
      });
    });
    expect(stub.only.url).toBe(`${BASE}/api/v1/project/p%201`);
  });

  it("search matches name, version, classifier and tag names", async () => {
    const stub = serve(JSON.stringify(PROJECTS));
    const uuids = async (query: string): Promise<unknown[]> => {
      let out: unknown;
      await configured(async () => {
        out = await tools.callJson("dependencytrack_search", { query });
      });
      return (out as { matches: { uuid: string }[] }).matches.map((m) => m.uuid);
    };
    expect(await uuids("SHOP")).toEqual(["p-1"]);
    expect(await uuids("1.0.3")).toEqual(["p-2"]);
    expect(await uuids("library")).toEqual(["p-2"]);
    expect(await uuids("pci")).toEqual(["p-2"]);
    expect(await uuids("container")).toEqual([]);
    expect(stub.calls[0]?.url).toBe(
      `${BASE}/api/v1/project?pageSize=100&pageNumber=1&excludeInactive=false`,
    );
  });

  it("refuses without DEPENDENCYTRACK_API_KEY, before any request, and quotes a failure", async () => {
    const stub = serve("[]");
    await withEnv({ DEPENDENCYTRACK_URL: BASE, DEPENDENCYTRACK_API_KEY: " " }, async () => {
      await expect(tools.call("dependencytrack_list", {})).rejects.toThrow(
        "DEPENDENCYTRACK_API_KEY is not set",
      );
    });
    expect(stub.calls).toEqual([]);

    serve({ status: 401, body: "Unauthorized" });
    await configured(async () => {
      await expect(tools.call("dependencytrack_get", { uuid: "p-9" })).rejects.toThrow(
        "Dependency-Track 401: Unauthorized",
      );
    });
  });
});
