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
import { CANVA_TOOL_NAMES, registerCanvaTools } from "../src/tools.ts";

const API = "https://api.canva.com/rest/v1";

const DESIGNS = {
  items: [
    { id: "D1", title: "Launch deck" },
    { id: "D2", title: "Team offsite poster" },
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
  return withEnv({ CANVA_TOKEN: "canva-token" }, fn);
}

beforeEach(() => {
  tools = captureTools(registerCanvaTools);
});

afterEach(() => {
  http?.restore();
  http = undefined;
});

describe("canva tools", () => {
  it("registers exactly CANVA_TOOL_NAMES", () => {
    expect(tools.names()).toEqual([...CANVA_TOOL_NAMES].sort(byToolName));
  });

  it("list sends no query on the first page and the continuation token after it", async () => {
    const stub = serve(JSON.stringify(DESIGNS));
    await configured(async () => {
      expect(await tools.callJson("canva_list", {})).toEqual(DESIGNS);
      await tools.call("canva_list", { continuation: "page 2/x" });
      // An empty token is the same as none.
      await tools.call("canva_list", { continuation: "" });
    });
    expect(stub.calls.map((c) => c.url)).toEqual([
      `${API}/designs`,
      `${API}/designs?continuation=page+2%2Fx`,
      `${API}/designs`,
    ]);
    expect(stub.calls[0]?.headers["authorization"]).toBe("Bearer canva-token");
  });

  it("get fetches one design by its encoded id", async () => {
    const stub = serve('{"design":{"id":"D/1"}}');
    await configured(async () => {
      expect(await tools.callJson("canva_get", { id: "D/1" })).toEqual({ design: { id: "D/1" } });
    });
    expect(stub.only.url).toBe(`${API}/designs/D%2F1`);
  });

  it("search matches design titles on the first page", async () => {
    const stub = serve(JSON.stringify(DESIGNS));
    const ids = async (query: string): Promise<unknown[]> => {
      let out: unknown;
      await configured(async () => {
        out = await tools.callJson("canva_search", { query });
      });
      return (out as { matches: { id: string }[] }).matches.map((m) => m.id);
    };
    expect(await ids("DECK")).toEqual(["D1"]);
    expect(await ids("offsite")).toEqual(["D2"]);
    expect(await ids("D1")).toEqual([]);
    expect(stub.calls[0]?.url).toBe(`${API}/designs`);
  });

  it("search finds nothing in an answer that carries no `items` array", async () => {
    serve('{"continuation":"x"}');
    await configured(async () => {
      expect(await tools.callJson("canva_search", { query: "deck" })).toEqual({ matches: [] });
    });
  });

  it("refuses without CANVA_TOKEN, before any request, and quotes an API failure", async () => {
    const stub = serve("{}");
    await withEnv({ CANVA_TOKEN: undefined }, async () => {
      await expect(tools.call("canva_list", {})).rejects.toThrow("CANVA_TOKEN is not set");
    });
    expect(stub.calls).toEqual([]);

    serve({ status: 403, body: "missing scope design:meta:read" });
    await configured(async () => {
      await expect(tools.call("canva_get", { id: "D1" })).rejects.toThrow(
        "Canva 403: missing scope design:meta:read",
      );
    });
  });
});
