import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  type CapturedTools,
  captureTools,
  type FetchStub,
  type RecordedRequest,
  type StubReply,
  stubFetch,
  withEnv,
} from "../../../scripts/connector-tool-harness.ts";
import {
  __resetSupersetLoginForTests,
  registerSupersetTools,
  SUPERSET_TOOL_NAMES,
} from "../src/tools.ts";

const BASE = "https://superset.example.com";
const LOGIN_URL = `${BASE}/api/v1/security/login`;
const LOGIN = '{"access_token":"jwt-1","refresh_token":"r"}';

const DASHBOARDS = {
  result: [
    { id: 1, dashboard_title: "Revenue Overview", slug: "revenue" },
    { id: 2, dashboard_title: "Churn", slug: "customer-churn" },
  ],
};

/** `/api/v1/dashboard/?q=(page:P,page_size:N)`, encoded as the connector sends it. */
function listUrl(pageSize: number): string {
  return `${BASE}/api/v1/dashboard/?q=${encodeURIComponent(`(page:0,page_size:${String(pageSize)})`)}`;
}

let tools: CapturedTools;
let http: FetchStub | undefined;

/** Answer the login endpoint with `login`, and the dashboard API with `api`. */
function serve(api: StubReply, login: StubReply = LOGIN): FetchStub {
  http?.restore();
  http = stubFetch((req: RecordedRequest) => (req.url === LOGIN_URL ? login : api));
  return http;
}

/** Run `fn` against a base URL with a trailing slash, which must not double into the path. */
function configured(fn: () => Promise<void>): Promise<void> {
  return withEnv(
    { SUPERSET_URL: `${BASE}/`, SUPERSET_USERNAME: "admin", SUPERSET_PASSWORD: "pw" },
    fn,
  );
}

beforeEach(() => {
  __resetSupersetLoginForTests();
  tools = captureTools(registerSupersetTools);
});

afterEach(() => {
  http?.restore();
  http = undefined;
  __resetSupersetLoginForTests();
});

describe("superset tools", () => {
  it("registers exactly SUPERSET_TOOL_NAMES", () => {
    expect(tools.names()).toEqual([...SUPERSET_TOOL_NAMES]);
  });

  it("logs in once with the database provider, then sends the JWT on every call", async () => {
    const stub = serve(JSON.stringify(DASHBOARDS));
    await configured(async () => {
      expect(await tools.callJson("superset_list", {})).toEqual(DASHBOARDS.result);
      expect(await tools.callJson("superset_get", { id: 2 })).toEqual(DASHBOARDS);
    });
    expect(stub.calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      `POST ${LOGIN_URL}`,
      `GET ${listUrl(100)}`,
      `GET ${BASE}/api/v1/dashboard/2`,
    ]);
    expect(JSON.parse(stub.calls[0]?.body ?? "null")).toEqual({
      username: "admin",
      password: "pw",
      provider: "db",
      refresh: true,
    });
    expect(stub.calls[1]?.headers["authorization"]).toBe("Bearer jwt-1");
    expect(stub.calls[2]?.headers["authorization"]).toBe("Bearer jwt-1");
  });

  it("list honours `limit`, and reads a bare-array answer as well as the envelope", async () => {
    const stub = serve(JSON.stringify(DASHBOARDS.result));
    await configured(async () => {
      expect(await tools.callJson("superset_list", { limit: 5 })).toEqual(DASHBOARDS.result);
    });
    expect(stub.calls[1]?.url).toBe(listUrl(5));
  });

  it("list answers an empty list when the answer carries no dashboards", async () => {
    serve('{"count":0}');
    await configured(async () => {
      expect(await tools.callJson("superset_list", {})).toEqual([]);
    });
  });

  it("search matches dashboard titles and slugs across a 500-dashboard page", async () => {
    const stub = serve(JSON.stringify(DASHBOARDS));
    const ids = async (query: string, limit?: number): Promise<unknown[]> => {
      let out: unknown;
      await configured(async () => {
        out = await tools.callJson("superset_search", {
          query,
          ...(limit === undefined ? {} : { limit }),
        });
      });
      return (out as { matches: { id: number }[] }).matches.map((m) => m.id);
    };
    expect(await ids("REVENUE")).toEqual([1]);
    expect(await ids("customer-churn")).toEqual([2]);
    expect(await ids("r", 1)).toEqual([1]);
    expect(await ids("finance")).toEqual([]);
    expect(stub.calls.filter((c) => c.url !== LOGIN_URL)[0]?.url).toBe(listUrl(500));
  });

  it("quotes Superset's status and body when a request fails", async () => {
    serve({ status: 404, body: '{"message":"Not found"}' });
    await configured(async () => {
      await expect(tools.call("superset_get", { id: 9 })).rejects.toThrow(
        'Superset 404: {"message":"Not found"}',
      );
    });
  });

  it("names the login, and sends nothing else, when the credentials are refused", async () => {
    const stub = serve("[]", { status: 401, body: "bad credentials" });
    await configured(async () => {
      await expect(tools.call("superset_list", {})).rejects.toThrow(
        "Superset login 401: bad credentials",
      );
    });
    expect(stub.calls.map((c) => c.url)).toEqual([LOGIN_URL]);
  });

  it("refuses without its configuration, before any request", async () => {
    const stub = serve("[]");
    for (const [missing, env] of [
      ["SUPERSET_URL", { SUPERSET_URL: undefined, SUPERSET_USERNAME: "u", SUPERSET_PASSWORD: "p" }],
      ["SUPERSET_USERNAME", { SUPERSET_URL: BASE, SUPERSET_USERNAME: "", SUPERSET_PASSWORD: "p" }],
      [
        "SUPERSET_PASSWORD",
        { SUPERSET_URL: BASE, SUPERSET_USERNAME: "u", SUPERSET_PASSWORD: undefined },
      ],
    ] as const) {
      await withEnv(env, async () => {
        await expect(tools.call("superset_list", {})).rejects.toThrow(`${missing} is not set`);
      });
    }
    expect(stub.calls).toEqual([]);
  });
});
