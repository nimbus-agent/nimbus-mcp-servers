import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  type CapturedTools,
  captureStandaloneTools,
  captureTools,
  type FetchStub,
  type RecordedRequest,
  type StubReply,
  stubFetch,
  withEnv,
} from "../../../scripts/connector-tool-harness.ts";
import { resetConnectorModeForTests, setConnectorMode } from "../../../shared/connector-mode.ts";
import { registerPowerBiTools } from "../src/server.ts";

const TOKEN_URL = "https://login.microsoftonline.com/tenant-1/oauth2/v2.0/token";
const REPORTS_URL = "https://api.powerbi.com/v1.0/myorg/reports";
const TOKEN = '{"access_token":"pbi-token"}';

const REPORTS = {
  value: [
    { id: "r1", name: "Sales Pipeline", description: "Quarterly pipeline", datasetId: "d1" },
    { id: "r2", name: "Headcount", description: "HR dashboard" },
  ],
};

let http: FetchStub | undefined;

/** Answer the token endpoint with `token`; every other request goes to `api`. */
function serve(
  api: StubReply | ((req: RecordedRequest) => StubReply | undefined),
  token: StubReply = TOKEN,
): FetchStub {
  http?.restore();
  http = stubFetch((req: RecordedRequest) => {
    if (req.url === TOKEN_URL) return token;
    return typeof api === "function" ? api(req) : api;
  });
  return http;
}

const CREDENTIALS = {
  POWERBI_TENANT_ID: "tenant-1",
  POWERBI_CLIENT_ID: "client 1",
  POWERBI_CLIENT_SECRET: "s&cret",
};

function configured(fn: () => Promise<void>): Promise<void> {
  return withEnv(CREDENTIALS, fn);
}

beforeEach(() => {
  resetConnectorModeForTests();
});

afterEach(() => {
  http?.restore();
  http = undefined;
  resetConnectorModeForTests();
});

describe("power bi reads (gateway mode)", () => {
  let tools: CapturedTools;

  beforeEach(() => {
    setConnectorMode("gateway");
    tools = captureTools(registerPowerBiTools);
  });

  it("get mints a client-credentials token, then finds the report by id", async () => {
    const stub = serve(JSON.stringify(REPORTS));
    await configured(async () => {
      expect(await tools.callJson("powerbi_get", { id: "r2" })).toEqual(REPORTS.value[1]);
    });
    expect(stub.calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      `POST ${TOKEN_URL}`,
      `GET ${REPORTS_URL}`,
    ]);
    expect(Object.fromEntries(new URLSearchParams(stub.calls[0]?.body ?? ""))).toEqual({
      grant_type: "client_credentials",
      client_id: "client 1",
      client_secret: "s&cret",
      scope: "https://analysis.windows.net/powerbi/api/.default",
    });
    expect(stub.calls[1]?.headers["authorization"]).toBe("Bearer pbi-token");
  });

  it("get throws for an id no report carries, or when the answer carries no reports", async () => {
    for (const body of [JSON.stringify(REPORTS), '{"@odata.context":"x"}']) {
      serve(body);
      await configured(async () => {
        await expect(tools.call("powerbi_get", { id: "r9" })).rejects.toThrow(
          "Power BI report not found: r9",
        );
      });
    }
  });

  it("search matches report names and descriptions", async () => {
    serve(JSON.stringify(REPORTS));
    const ids = async (query: string): Promise<unknown[]> => {
      let out: unknown;
      await configured(async () => {
        out = await tools.callJson("powerbi_search", { query });
      });
      return (out as { matches: { id: string }[] }).matches.map((m) => m.id);
    };
    expect(await ids("PIPELINE")).toEqual(["r1"]);
    expect(await ids("hr dash")).toEqual(["r2"]);
    expect(await ids("finance")).toEqual([]);
  });

  it("names the reports request when it fails", async () => {
    serve({ status: 500, body: "service unavailable" });
    await configured(async () => {
      await expect(tools.call("powerbi_search", { query: "x" })).rejects.toThrow(
        "Power BI reports error 500: service unavailable",
      );
    });
  });

  it("refuses a token answer that is not an object, has no token, or is an error", async () => {
    for (const [token, message] of [
      [{ body: "[]" }, "Power BI token response: unexpected shape"],
      [{ body: '{"token_type":"Bearer"}' }, "Power BI token response: missing access_token"],
      [{ status: 401, body: "AADSTS7000215" }, "Power BI token error 401: AADSTS7000215"],
    ] as const) {
      const stub = serve(JSON.stringify(REPORTS), token);
      await configured(async () => {
        await expect(tools.call("powerbi_get", { id: "r1" })).rejects.toThrow(message);
      });
      expect(stub.calls.map((c) => c.url)).toEqual([TOKEN_URL]);
    }
  });

  it("list expands only what it can, and never fails a report for its tables", async () => {
    const stub = serve((req) => {
      if (req.url === REPORTS_URL) {
        return JSON.stringify({
          value: [
            { id: "a", datasetId: "ok" },
            { id: "b", datasetId: "broken" },
            { id: "c", datasetId: "odd" },
            { id: "d" },
            "not a report",
          ],
        });
      }
      if (req.url.endsWith("/datasets/ok/tables")) {
        return JSON.stringify({ value: [{ name: "orders" }, { name: "" }, { title: "x" }, 7] });
      }
      if (req.url.endsWith("/datasets/broken/tables")) return { status: 404, body: "gone" };
      if (req.url.endsWith("/datasets/odd/tables")) return '{"value":"not a list"}';
      return undefined;
    });
    let out: unknown;
    await configured(async () => {
      out = await tools.callJson("powerbi_list", {});
    });
    expect(out).toEqual({
      items: [
        { id: "a", datasetId: "ok", datasetTables: ["orders"] },
        { id: "b", datasetId: "broken", datasetTables: [] },
        { id: "c", datasetId: "odd", datasetTables: [] },
        { id: "d", datasetTables: [] },
        "not a report",
      ],
      nextCursor: null,
    });
    // One tables request per report that names a dataset, and none for the others.
    expect(stub.calls.filter((c) => c.url.includes("/tables"))).toHaveLength(3);
  });

  it("refuses without its client credentials, before any request", async () => {
    const stub = serve("{}");
    for (const missing of Object.keys(CREDENTIALS)) {
      await configured(async () => {
        await withEnv({ [missing]: undefined }, async () => {
          await expect(tools.call("powerbi_get", { id: "r1" })).rejects.toThrow(
            `${missing} is not set`,
          );
        });
      });
    }
    expect(stub.calls).toEqual([]);
  });
});

describe("power bi write scope (standalone mode)", () => {
  /** Register for a client that can prompt, with My Workspace and group g1 in scope. */
  async function standalone(): Promise<CapturedTools> {
    setConnectorMode("standalone");
    let tools: CapturedTools | undefined;
    await withEnv(
      {
        NIMBUS_MCP_POWERBI_WRITE_SCOPE: "workspace:my-workspace,workspace:g1",
        NIMBUS_MCP_AUDIT_LOG: undefined,
        NIMBUS_MCP_WRITE_BUDGET: undefined,
      },
      () => {
        tools = captureStandaloneTools(registerPowerBiTools, { elicitation: true }).tools;
      },
    );
    if (tools === undefined) throw new Error("registration did not run");
    return tools;
  }

  it("scopes a dataset refresh with no group to My Workspace", async () => {
    const tools = await standalone();
    const stub = serve({ status: 202, body: "" });
    await configured(async () => {
      expect(await tools.callJson("powerbi_dataset_refresh", { datasetId: "d1" })).toEqual({
        status: "queued",
        datasetId: "d1",
      });
      expect(
        await tools.callJson("powerbi_dataset_refresh", { groupId: null, datasetId: "d1" }),
      ).toEqual({ status: "queued", datasetId: "d1" });
      expect(
        await tools.callJson("powerbi_dataset_refresh", { groupId: "g2", datasetId: "d1" }),
      ).toEqual({
        ok: false,
        error: "out of scope: workspace:g2 is not in NIMBUS_MCP_POWERBI_WRITE_SCOPE",
      });
    });
    // Two refreshes reached the API (each after its own token); the out-of-scope one did not.
    expect(stub.calls.filter((c) => c.url.endsWith("/refreshes")).map((c) => c.url)).toEqual([
      "https://api.powerbi.com/v1.0/myorg/datasets/d1/refreshes",
      "https://api.powerbi.com/v1.0/myorg/datasets/d1/refreshes",
    ]);
  });

  it("scopes a dataflow refresh to its group", async () => {
    const tools = await standalone();
    const stub = serve({ status: 202, body: "" });
    await configured(async () => {
      expect(
        await tools.callJson("powerbi_dataflow_refresh", { groupId: "g1", dataflowId: "f1" }),
      ).toEqual({ status: "queued", groupId: "g1", dataflowId: "f1" });
      expect(
        await tools.callJson("powerbi_dataflow_refresh", { groupId: "g2", dataflowId: "f1" }),
      ).toEqual({
        ok: false,
        error: "out of scope: workspace:g2 is not in NIMBUS_MCP_POWERBI_WRITE_SCOPE",
      });
    });
    expect(stub.calls.filter((c) => c.url.endsWith("/refreshes")).map((c) => c.url)).toEqual([
      "https://api.powerbi.com/v1.0/myorg/groups/g1/dataflows/f1/refreshes",
    ]);
  });
});
