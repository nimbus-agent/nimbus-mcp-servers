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
import { MIRO_TOOL_NAMES, registerMiroTools } from "../src/tools.ts";

const API = "https://api.miro.com/v2/boards";

const BOARDS = {
  data: [
    { id: "b1", name: "Roadmap", description: "Q3 plan", owner: { name: "Ada" } },
    { id: "b2", name: "Retro", description: "", owner: { name: "Grace" } },
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
  return withEnv({ MIRO_TOKEN: "miro-token" }, fn);
}

beforeEach(() => {
  tools = captureTools(registerMiroTools);
});

afterEach(() => {
  http?.restore();
  http = undefined;
});

describe("miro tools", () => {
  it("registers exactly MIRO_TOOL_NAMES", () => {
    expect(tools.names()).toEqual([...MIRO_TOOL_NAMES].sort(byToolName));
  });

  it("list asks for 50 boards by default, `limit` when given, and the cursor after page 1", async () => {
    const stub = serve(JSON.stringify(BOARDS));
    await configured(async () => {
      expect(await tools.callJson("miro_list", {})).toEqual(BOARDS);
      await tools.call("miro_list", { limit: 10, cursor: "c=2" });
      await tools.call("miro_list", { cursor: "" });
    });
    expect(stub.calls.map((c) => c.url)).toEqual([
      `${API}?limit=50`,
      `${API}?limit=10&cursor=c%3D2`,
      `${API}?limit=50`,
    ]);
    expect(stub.calls[0]?.headers["authorization"]).toBe("Bearer miro-token");
  });

  it("get fetches one board by its encoded id", async () => {
    const stub = serve('{"id":"uXjV=/"}');
    await configured(async () => {
      expect(await tools.callJson("miro_get", { id: "uXjV=/" })).toEqual({ id: "uXjV=/" });
    });
    expect(stub.only.url).toBe(`${API}/uXjV%3D%2F`);
  });

  it("search matches board name, description and owner name on the first page", async () => {
    const stub = serve(JSON.stringify(BOARDS));
    const ids = async (query: string): Promise<unknown[]> => {
      let out: unknown;
      await configured(async () => {
        out = await tools.callJson("miro_search", { query });
      });
      return (out as { matches: { id: string }[] }).matches.map((m) => m.id);
    };
    expect(await ids("ROADMAP")).toEqual(["b1"]);
    expect(await ids("q3")).toEqual(["b1"]);
    expect(await ids("grace")).toEqual(["b2"]);
    expect(await ids("kanban")).toEqual([]);
    expect(stub.calls[0]?.url).toBe(`${API}?limit=50`);
  });

  it("search finds nothing in an answer that carries no `data` array", async () => {
    serve('{"total":0}');
    await configured(async () => {
      expect(await tools.callJson("miro_search", { query: "roadmap" })).toEqual({ matches: [] });
    });
  });

  it("refuses without MIRO_TOKEN, before any request, and quotes an API failure", async () => {
    const stub = serve("{}");
    await withEnv({ MIRO_TOKEN: undefined }, async () => {
      await expect(tools.call("miro_list", {})).rejects.toThrow("MIRO_TOKEN is not set");
    });
    expect(stub.calls).toEqual([]);

    serve({ status: 404, body: "board not found" });
    await configured(async () => {
      await expect(tools.call("miro_get", { id: "gone" })).rejects.toThrow(
        "Miro 404: board not found",
      );
    });
  });
});
