import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  byToolName,
  type CapturedTools,
  captureTools,
  type FetchStub,
  type RecordedRequest,
  type StubReply,
  stubFetch,
  withEnv,
} from "../../../scripts/connector-tool-harness.ts";
import { RAINDROP_TOOL_NAMES, registerRaindropTools } from "../src/tools.ts";

const API = "https://api.raindrop.io/rest/v1";

const ROOT_COLLECTIONS = { items: [{ _id: 1, title: "Reading", view: "list", color: "#ff0000" }] };
const CHILD_COLLECTIONS = {
  items: [{ _id: 2, title: "Papers", view: "grid", parent: { $id: 1 } }],
};
const BOOKMARKS = {
  items: [
    { _id: 10, title: "Bun 1.3 release notes", domain: "bun.sh", tags: ["runtime"] },
    { _id: 11, title: "Zod 4", domain: "zod.dev", tags: ["validation"] },
  ],
};

let tools: CapturedTools;
let http: FetchStub | undefined;

function serve(reply: StubReply | ((req: RecordedRequest) => StubReply | undefined)): FetchStub {
  http?.restore();
  http = stubFetch(reply);
  return http;
}

/** Root and nested collections from their two endpoints; nothing else is expected. */
function collections(req: RecordedRequest): StubReply | undefined {
  if (req.url === `${API}/collections`) return JSON.stringify(ROOT_COLLECTIONS);
  if (req.url === `${API}/collections/childrens`) return JSON.stringify(CHILD_COLLECTIONS);
  return undefined;
}

function configured(fn: () => Promise<void>): Promise<void> {
  return withEnv({ RAINDROP_TOKEN: "rd-token" }, fn);
}

beforeEach(() => {
  tools = captureTools(registerRaindropTools);
});

afterEach(() => {
  http?.restore();
  http = undefined;
});

describe("raindrop tools", () => {
  it("registers exactly RAINDROP_TOOL_NAMES", () => {
    expect(tools.names()).toEqual([...RAINDROP_TOOL_NAMES].sort(byToolName));
  });

  it("list reads the special all-bookmarks collection 0, 50 per page", async () => {
    const stub = serve(JSON.stringify(BOOKMARKS));
    await configured(async () => {
      expect(await tools.callJson("raindrop_list", {})).toEqual(BOOKMARKS);
    });
    expect(stub.only.url).toBe(`${API}/raindrops/0?perpage=50`);
    expect(stub.only.headers["authorization"]).toBe("Bearer rd-token");
  });

  it("get and collection_get use the SINGULAR paths with an encoded id", async () => {
    const stub = serve('{"result":true}');
    await configured(async () => {
      await tools.call("raindrop_get", { id: "10/x" });
      await tools.call("raindrop_collection_get", { id: "2/y" });
    });
    expect(stub.calls.map((c) => c.url)).toEqual([
      `${API}/raindrop/10%2Fx`,
      `${API}/collection/2%2Fy`,
    ]);
  });

  it("search matches bookmarks on the first page", async () => {
    serve(JSON.stringify(BOOKMARKS));
    await configured(async () => {
      expect(await tools.callJson("raindrop_search", { query: "ZOD" })).toEqual({
        matches: [BOOKMARKS.items[1]],
      });
    });
  });

  it("collections_list drains root AND nested collections and concatenates them", async () => {
    const stub = serve(collections);
    await configured(async () => {
      expect(await tools.callJson("raindrop_collections_list", {})).toEqual({
        items: [...ROOT_COLLECTIONS.items, ...CHILD_COLLECTIONS.items],
      });
    });
    expect(stub.calls.map((c) => c.url).sort()).toEqual([
      `${API}/collections`,
      `${API}/collections/childrens`,
    ]);
  });

  it("collections_list keeps the endpoint that answered when the other carries no items", async () => {
    serve((req) => (req.url === `${API}/collections` ? '{"result":true}' : collections(req)));
    await configured(async () => {
      expect(await tools.callJson("raindrop_collections_list", {})).toEqual({
        items: CHILD_COLLECTIONS.items,
      });
    });
  });

  it("collections_search matches across root and nested collections", async () => {
    serve(collections);
    const ids = async (query: string): Promise<unknown[]> => {
      let out: unknown;
      await configured(async () => {
        out = await tools.callJson("raindrop_collections_search", { query });
      });
      return (out as { matches: { _id: number }[] }).matches.map((m) => m._id);
    };
    expect(await ids("papers")).toEqual([2]);
    expect(await ids("LIST")).toEqual([1]);
    expect(await ids("archive")).toEqual([]);
  });

  it("refuses without RAINDROP_TOKEN, before any request, and quotes an API failure", async () => {
    const stub = serve("{}");
    await withEnv({ RAINDROP_TOKEN: undefined }, async () => {
      await expect(tools.call("raindrop_collections_list", {})).rejects.toThrow(
        "RAINDROP_TOKEN is not set",
      );
    });
    expect(stub.calls).toEqual([]);

    serve({ status: 404, body: '{"result":false}' });
    await configured(async () => {
      await expect(tools.call("raindrop_get", { id: "9" })).rejects.toThrow(
        'Raindrop 404: {"result":false}',
      );
    });
  });
});
