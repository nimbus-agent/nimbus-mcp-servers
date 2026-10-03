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
import { HUBSPOT_TOOL_NAMES, registerHubspotTools } from "../src/tools.ts";

const API = "https://api.hubapi.com/crm/v3/objects/deals";
const PROPERTIES =
  "properties=dealname%2Camount%2Cdealstage%2Cpipeline%2Cclosedate%2Ccreatedate%2Chs_lastmodifieddate";

const DEALS = {
  results: [
    {
      id: "1",
      properties: { dealname: "Acme renewal", dealstage: "closedwon", pipeline: "default" },
    },
    {
      id: "2",
      properties: { dealname: "Globex pilot", dealstage: "appointment", pipeline: "smb" },
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
  return withEnv({ HUBSPOT_TOKEN: "pat-na1-x" }, fn);
}

beforeEach(() => {
  tools = captureTools(registerHubspotTools);
});

afterEach(() => {
  http?.restore();
  http = undefined;
});

describe("hubspot tools", () => {
  it("registers exactly HUBSPOT_TOOL_NAMES", () => {
    expect(tools.names()).toEqual([...HUBSPOT_TOOL_NAMES].sort(byToolName));
  });

  it("list asks for 100 deals by default and `limit` when given, with the deal properties", async () => {
    const stub = serve(JSON.stringify(DEALS));
    await configured(async () => {
      expect(await tools.callJson("hubspot_list", {})).toEqual(DEALS);
      await tools.call("hubspot_list", { limit: 5 });
    });
    expect(stub.calls.map((c) => c.url)).toEqual([
      `${API}?limit=100&${PROPERTIES}`,
      `${API}?limit=5&${PROPERTIES}`,
    ]);
    expect(stub.calls[0]?.headers["authorization"]).toBe("Bearer pat-na1-x");
  });

  it("get fetches one deal by its encoded id, with the deal properties", async () => {
    const stub = serve('{"id":"1"}');
    await configured(async () => {
      expect(await tools.callJson("hubspot_get", { id: "1/2" })).toEqual({ id: "1" });
    });
    expect(stub.only.url).toBe(`${API}/1%2F2?${PROPERTIES}`);
  });

  it("search matches deal name, stage and pipeline on the first page", async () => {
    const stub = serve(JSON.stringify(DEALS));
    const ids = async (query: string): Promise<unknown[]> => {
      let out: unknown;
      await configured(async () => {
        out = await tools.callJson("hubspot_search", { query });
      });
      return (out as { matches: { id: string }[] }).matches.map((m) => m.id);
    };
    expect(await ids("ACME")).toEqual(["1"]);
    expect(await ids("appointment")).toEqual(["2"]);
    expect(await ids("smb")).toEqual(["2"]);
    expect(await ids("initech")).toEqual([]);
    expect(stub.calls[0]?.url).toBe(`${API}?limit=100&${PROPERTIES}`);
  });

  it("search finds nothing in an answer that carries no `results` array", async () => {
    serve('{"status":"error"}');
    await configured(async () => {
      expect(await tools.callJson("hubspot_search", { query: "acme" })).toEqual({ matches: [] });
    });
  });

  it("refuses without HUBSPOT_TOKEN, before any request, and quotes an API failure", async () => {
    const stub = serve("{}");
    await withEnv({ HUBSPOT_TOKEN: undefined }, async () => {
      await expect(tools.call("hubspot_list", {})).rejects.toThrow("HUBSPOT_TOKEN is not set");
    });
    expect(stub.calls).toEqual([]);

    serve({ status: 404, body: '{"message":"Object not found"}' });
    await configured(async () => {
      await expect(tools.call("hubspot_get", { id: "9" })).rejects.toThrow(
        'HubSpot 404: {"message":"Object not found"}',
      );
    });
  });
});
