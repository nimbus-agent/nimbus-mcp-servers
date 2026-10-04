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
import { registerBigeyeTools } from "../src/server.ts";

const ISSUES = [
  { id: "is-1", title: "Freshness: orders", description: "orders table is 6h stale" },
  { id: 42, title: "Null rate: customers.email", description: "null rate above 5%" },
  // Rows a misbehaving API could return: none has a usable id.
  { id: { nested: true }, title: "weird" },
  ["not", "a", "row"],
  null,
];

let tools: CapturedTools;
let http: FetchStub | undefined;

function serve(reply: StubReply): FetchStub {
  http?.restore();
  http = stubFetch(reply);
  return http;
}

/** Run `fn` against a base URL that ends in a slash. */
function configured(fn: () => Promise<void>): Promise<void> {
  return withEnv({ BIGEYE_BASE_URL: "https://bigeye.example.com/", BIGEYE_API_KEY: "bk" }, fn);
}

beforeEach(() => {
  resetConnectorModeForTests();
  setConnectorMode("gateway");
  tools = captureTools(registerBigeyeTools);
});

afterEach(() => {
  http?.restore();
  http = undefined;
  resetConnectorModeForTests();
});

describe("bigeye reads", () => {
  it("get finds an issue by string id, and by numeric id compared as a string", async () => {
    const stub = serve(JSON.stringify(ISSUES));
    await configured(async () => {
      expect(await tools.callJson("bigeye_get", { id: "is-1" })).toEqual(ISSUES[0]);
      expect(await tools.callJson("bigeye_get", { id: "42" })).toEqual(ISSUES[1]);
    });
    // One trailing slash is dropped from the base, never doubled into the path.
    expect(stub.calls[0]?.url).toBe("https://bigeye.example.com/api/v1/issues?limit=500&offset=0");
    expect(stub.calls[0]?.headers["authorization"]).toBe("Bearer bk");
  });

  it("get throws for an id no row carries", async () => {
    serve(JSON.stringify(ISSUES));
    await configured(async () => {
      await expect(tools.call("bigeye_get", { id: "is-404" })).rejects.toThrow(
        "Bigeye issue not found: is-404",
      );
    });
  });

  it("reads the issues out of an { issues } or { data } envelope as well as a bare array", async () => {
    for (const body of [{ issues: ISSUES }, { data: ISSUES }]) {
      serve(JSON.stringify(body));
      await configured(async () => {
        expect(await tools.callJson("bigeye_get", { id: "is-1" })).toEqual(ISSUES[0]);
      });
    }
  });

  it("treats an answer with no recognisable list as no issues", async () => {
    for (const body of ['{"items":[]}', "null", '"text"']) {
      serve(body);
      await configured(async () => {
        await expect(tools.call("bigeye_get", { id: "is-1" })).rejects.toThrow(
          "Bigeye issue not found: is-1",
        );
        expect(await tools.callJson("bigeye_search", { query: "orders" })).toEqual({ matches: [] });
      });
    }
  });

  it("search matches issues by title and description", async () => {
    serve(JSON.stringify({ issues: ISSUES }));
    await configured(async () => {
      expect(await tools.callJson("bigeye_search", { query: "STALE" })).toEqual({
        matches: [ISSUES[0]],
      });
      expect(await tools.callJson("bigeye_search", { query: "customers.email" })).toEqual({
        matches: [ISSUES[1]],
      });
    });
  });

  it("surfaces a failed read with its status and body", async () => {
    serve({ status: 502, body: "Bad Gateway" });
    await configured(async () => {
      await expect(tools.call("bigeye_search", { query: "x" })).rejects.toThrow(
        "Bigeye 502: Bad Gateway",
      );
    });
  });
});
