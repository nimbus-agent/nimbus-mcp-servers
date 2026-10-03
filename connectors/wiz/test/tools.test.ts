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
import { __resetWizTokenForTests, registerWizTools, WIZ_TOOL_NAMES } from "../src/tools.ts";

const API = "https://api.app.wiz.io/graphql";
const AUTH = "https://auth.app.wiz.io/oauth/token";
const TOKEN = '{"access_token":"wiz-access","expires_in":86400}';

const ISSUES = [
  {
    id: "i1",
    sourceRule: { id: "r1", name: "Public S3 bucket" },
    description: "Bucket allows anonymous reads",
    entity: { id: "e1", name: "logs-bucket", type: "BUCKET" },
    projects: [{ id: "p1", name: "Platform", slug: "platform" }],
  },
  {
    id: "i2",
    sourceRule: { id: "r2", name: "Outdated kernel" },
    description: "Kernel has known CVEs",
    entity: { id: "e2", name: "web-01", type: "VIRTUAL_MACHINE" },
    projects: [{ id: "p2", name: "Storefront", slug: "store" }],
  },
];

function page(nodes: unknown[]): string {
  return JSON.stringify({
    data: { issues: { nodes, pageInfo: { hasNextPage: false, endCursor: null } } },
  });
}

let tools: CapturedTools;
let http: FetchStub | undefined;

/** Answer the auth endpoint with `token`, and the GraphQL API with `api`. */
function serve(api: StubReply, token: StubReply = TOKEN): FetchStub {
  http?.restore();
  http = stubFetch((req: RecordedRequest) => (req.url === AUTH ? token : api));
  return http;
}

function configured(fn: () => Promise<void>): Promise<void> {
  return withEnv(
    {
      WIZ_CLIENT_ID: "client-id",
      WIZ_CLIENT_SECRET: "client-secret",
      WIZ_API_URL: undefined,
      WIZ_AUTH_URL: undefined,
    },
    fn,
  );
}

/** The GraphQL variables one request carried. */
function variables(req: RecordedRequest | undefined): unknown {
  return (JSON.parse(req?.body ?? "null") as { variables: unknown }).variables;
}

beforeEach(() => {
  __resetWizTokenForTests();
  tools = captureTools(registerWizTools);
});

afterEach(() => {
  http?.restore();
  http = undefined;
  __resetWizTokenForTests();
});

describe("wiz tools", () => {
  it("registers exactly WIZ_TOOL_NAMES", () => {
    expect(tools.names()).toEqual([...WIZ_TOOL_NAMES]);
  });

  it("exchanges client credentials once, then queries open issues with the bearer token", async () => {
    const stub = serve(page(ISSUES));
    await configured(async () => {
      expect(await tools.callJson("wiz_list", {})).toEqual({
        nodes: ISSUES,
        pageInfo: { hasNextPage: false, endCursor: null },
      });
      await tools.call("wiz_list", {});
    });
    expect(stub.calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      `POST ${AUTH}`,
      `POST ${API}`,
      `POST ${API}`,
    ]);
    const [exchange, query] = stub.calls;
    expect(Object.fromEntries(new URLSearchParams(exchange?.body ?? ""))).toEqual({
      grant_type: "client_credentials",
      client_id: "client-id",
      client_secret: "client-secret",
      audience: "wiz-api",
    });
    expect(query?.headers["authorization"]).toBe("Bearer wiz-access");
    expect(variables(query)).toEqual({ first: 100, after: null, filterBy: { status: ["OPEN"] } });
  });

  it("list sends every filter it is given", async () => {
    const stub = serve(page([]));
    await configured(async () => {
      await tools.call("wiz_list", {
        severity: ["HIGH", "CRITICAL"],
        status: ["OPEN", "IN_PROGRESS"],
        entityType: "BUCKET",
        limit: 20,
      });
    });
    expect(variables(stub.calls[1])).toEqual({
      first: 20,
      after: null,
      filterBy: {
        status: ["OPEN", "IN_PROGRESS"],
        severity: ["HIGH", "CRITICAL"],
        entityType: "BUCKET",
      },
    });
  });

  it("get returns the one issue, and throws when Wiz has no such issue", async () => {
    const found = serve(JSON.stringify({ data: { issue: ISSUES[0] } }));
    await configured(async () => {
      expect(await tools.callJson("wiz_get", { issueId: "i1" })).toEqual(ISSUES[0]);
    });
    expect(variables(found.calls[1])).toEqual({ id: "i1" });

    serve(JSON.stringify({ data: { issue: null } }));
    await configured(async () => {
      await expect(tools.call("wiz_get", { issueId: "i404" })).rejects.toThrow(
        "Wiz: issue i404 not found",
      );
    });
  });

  it("search matches rule, description, entity name and type, and project names", async () => {
    const stub = serve(page(ISSUES));
    const ids = async (query: string, limit?: number): Promise<unknown[]> => {
      let out: unknown;
      await configured(async () => {
        out = await tools.callJson("wiz_search", {
          query,
          ...(limit === undefined ? {} : { limit }),
        });
      });
      return (out as { matches: { id: string }[] }).matches.map((m) => m.id);
    };
    expect(await ids("PUBLIC S3")).toEqual(["i1"]);
    expect(await ids("known cves")).toEqual(["i2"]);
    expect(await ids("web-01")).toEqual(["i2"]);
    expect(await ids("bucket")).toEqual(["i1"]);
    expect(await ids("storefront")).toEqual(["i2"]);
    expect(await ids("e", 1)).toEqual(["i1"]);
    expect(variables(stub.calls[1])).toEqual({
      first: 500,
      after: null,
      filterBy: { status: ["OPEN"] },
    });
  });

  it("talks to the configured auth and API endpoints", async () => {
    http?.restore();
    http = stubFetch((req: RecordedRequest) =>
      req.url === "https://auth.wiz.example/token" ? TOKEN : page([]),
    );
    await withEnv(
      {
        WIZ_CLIENT_ID: "i",
        WIZ_CLIENT_SECRET: "s",
        WIZ_AUTH_URL: "https://auth.wiz.example/token",
        WIZ_API_URL: "https://api.wiz.example/graphql",
      },
      async () => {
        await tools.call("wiz_list", {});
      },
    );
    expect(http.calls.map((c) => c.url)).toEqual([
      "https://auth.wiz.example/token",
      "https://api.wiz.example/graphql",
    ]);
  });

  it("names the auth exchange, and queries nothing, when it is refused", async () => {
    const stub = serve(page([]), { status: 401, body: "access_denied" });
    await configured(async () => {
      await expect(tools.call("wiz_list", {})).rejects.toThrow("Wiz auth 401: access_denied");
    });
    expect(stub.calls.map((c) => c.url)).toEqual([AUTH]);
  });

  it("surfaces GraphQL errors from an otherwise successful answer", async () => {
    serve(JSON.stringify({ errors: [{ message: "Unauthorized field" }] }));
    await configured(async () => {
      await expect(tools.call("wiz_search", { query: "x" })).rejects.toThrow(
        'Wiz GraphQL error: [{"message":"Unauthorized field"}]',
      );
    });
  });

  it("refuses without client credentials, before any request", async () => {
    const stub = serve(page([]));
    await withEnv({ WIZ_CLIENT_ID: "i", WIZ_CLIENT_SECRET: undefined }, async () => {
      await expect(tools.call("wiz_get", { issueId: "i1" })).rejects.toThrow(
        "WIZ_CLIENT_SECRET is not set",
      );
    });
    expect(stub.calls).toEqual([]);
  });
});
