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
import { registerMonteCarloTools } from "../src/server.ts";

const GRAPHQL = "https://api.getmontecarlo.com/graphql";

const INCIDENTS = [
  { incidentId: "inc-1", status: "OPEN", severity: "SEV_1", monitoredTable: "analytics:orders" },
  { incidentId: "inc-2", status: "RESOLVED", severity: "SEV_3", monitoredTable: "analytics:users" },
];

/** A `getIncidents` answer holding `nodes`, with an edge that carries no node mixed in. */
function incidentsAnswer(nodes: readonly unknown[]): string {
  return JSON.stringify({
    data: {
      getIncidents: {
        edges: [...nodes.map((node) => ({ node })), { cursor: "orphan-edge" }],
        pageInfo: { hasNextPage: false, endCursor: null },
      },
    },
  });
}

let tools: CapturedTools;
let http: FetchStub | undefined;

function serve(reply: StubReply): FetchStub {
  http?.restore();
  http = stubFetch(reply);
  return http;
}

function configured(fn: () => Promise<void>): Promise<void> {
  return withEnv({ MONTECARLO_API_ID: "mc-id", MONTECARLO_API_TOKEN: "mc-token" }, fn);
}

// The read surface in gateway mode; list paging and the writes have their own test files.
beforeEach(() => {
  resetConnectorModeForTests();
  setConnectorMode("gateway");
  tools = captureTools(registerMonteCarloTools);
});

afterEach(() => {
  http?.restore();
  http = undefined;
  resetConnectorModeForTests();
});

describe("monte-carlo read tools", () => {
  it("get asks for one page of 500 incidents and returns the one with that id", async () => {
    const stub = serve(incidentsAnswer(INCIDENTS));
    await configured(async () => {
      expect(await tools.callJson("montecarlo_get", { id: "inc-2" })).toEqual(INCIDENTS[1]);
    });
    expect(`${stub.only.method} ${stub.only.url}`).toBe(`POST ${GRAPHQL}`);
    expect(stub.only.headers["x-mcd-id"]).toBe("mc-id");
    expect(stub.only.headers["x-mcd-token"]).toBe("mc-token");
    expect((JSON.parse(stub.only.body ?? "null") as { variables: unknown }).variables).toEqual({
      first: 500,
      after: null,
    });
  });

  it("get names an incident that is not on the page", async () => {
    serve(incidentsAnswer(INCIDENTS));
    await configured(async () => {
      await expect(tools.call("montecarlo_get", { id: "inc-9" })).rejects.toThrow(
        "Monte Carlo incident not found: inc-9",
      );
    });
  });

  it("search matches incident id, status, severity and table, skipping node-less edges", async () => {
    serve(incidentsAnswer(INCIDENTS));
    const ids = async (query: string): Promise<unknown[]> => {
      let out: unknown;
      await configured(async () => {
        out = await tools.callJson("montecarlo_search", { query });
      });
      return (out as { matches: { incidentId: string }[] }).matches.map((m) => m.incidentId);
    };
    expect(await ids("INC-1")).toEqual(["inc-1"]);
    expect(await ids("resolved")).toEqual(["inc-2"]);
    expect(await ids("sev_3")).toEqual(["inc-2"]);
    expect(await ids("orders")).toEqual(["inc-1"]);
    expect(await ids("payments")).toEqual([]);
  });

  it("finds nothing in an answer that is not an object", async () => {
    serve('["unexpected"]');
    await configured(async () => {
      expect(await tools.callJson("montecarlo_search", { query: "inc" })).toEqual({
        matches: [],
      });
    });
  });

  it("reports a GraphQL error by its message, or verbatim when it has none", async () => {
    serve('{"errors":[{"message":"Unauthorized"}]}');
    await configured(async () => {
      await expect(tools.call("montecarlo_search", { query: "x" })).rejects.toThrow(
        "Monte Carlo GraphQL error: Unauthorized",
      );
    });
    serve('{"errors":[{"code":"RATE_LIMITED"}]}');
    await configured(async () => {
      await expect(tools.call("montecarlo_search", { query: "x" })).rejects.toThrow(
        'Monte Carlo GraphQL error: {"code":"RATE_LIMITED"}',
      );
    });
  });

  it("refuses without MONTECARLO_API_TOKEN, before any request, and quotes an HTTP failure", async () => {
    const stub = serve("{}");
    await withEnv({ MONTECARLO_API_ID: "mc-id", MONTECARLO_API_TOKEN: undefined }, async () => {
      await expect(tools.call("montecarlo_get", { id: "inc-1" })).rejects.toThrow(
        "MONTECARLO_API_TOKEN is not set",
      );
    });
    expect(stub.calls).toEqual([]);

    serve({ status: 503, body: "maintenance" });
    await configured(async () => {
      await expect(tools.call("montecarlo_get", { id: "inc-1" })).rejects.toThrow(
        "Monte Carlo API error 503: maintenance",
      );
    });
  });
});
