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
import { resetConnectorModeForTests, setConnectorMode } from "../../../shared/connector-mode.ts";
import { registerLookerTools } from "../src/server.ts";

const BASE = "https://looker.example.com";
const LOGIN = `${BASE}/api/4.0/login`;
const DASHBOARDS_URL = `${BASE}/api/4.0/dashboards`;

const DASHBOARDS = [
  { id: "7", title: "Revenue by Region" },
  { id: "12", title: "Funnel" },
  "not a dashboard",
];

let tools: CapturedTools;
let http: FetchStub | undefined;

/** Log in with `login`, and answer every other request with `api`. */
function serve(api: StubReply, login: StubReply = '{"access_token":"lk-token"}'): FetchStub {
  http?.restore();
  http = stubFetch((req: RecordedRequest) => (req.url === LOGIN ? login : api));
  return http;
}

function configured(fn: () => Promise<void>): Promise<void> {
  return withEnv(
    { LOOKER_BASE_URL: `${BASE}/`, LOOKER_CLIENT_ID: "id&1", LOOKER_CLIENT_SECRET: "s=cret" },
    fn,
  );
}

beforeEach(() => {
  resetConnectorModeForTests();
  setConnectorMode("gateway");
  tools = captureTools(registerLookerTools);
});

afterEach(() => {
  http?.restore();
  http = undefined;
  resetConnectorModeForTests();
});

describe("looker reads", () => {
  it("get logs in with the client credentials, then finds the dashboard by id", async () => {
    const stub = serve(JSON.stringify(DASHBOARDS));
    await configured(async () => {
      expect(await tools.callJson("looker_get", { id: "12" })).toEqual(DASHBOARDS[1]);
    });
    expect(stub.calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      `POST ${LOGIN}`,
      `GET ${DASHBOARDS_URL}`,
    ]);
    // The credentials are form-encoded, so `&` and `=` in them cannot split the body.
    expect(stub.calls[0]?.body).toBe("client_id=id%261&client_secret=s%3Dcret");
    expect(stub.calls[1]?.headers["authorization"]).toBe("Bearer lk-token");
  });

  it("get throws for an id no dashboard carries, and for an answer that is not a list", async () => {
    for (const body of [JSON.stringify(DASHBOARDS), '{"dashboards":[]}']) {
      serve(body);
      await configured(async () => {
        await expect(tools.call("looker_get", { id: "99" })).rejects.toThrow(
          "Looker dashboard not found: 99",
        );
      });
    }
  });

  it("search matches dashboard titles and ids, within the limit", async () => {
    serve(JSON.stringify(DASHBOARDS));
    const ids = async (query: string, limit?: number): Promise<unknown[]> => {
      let out: unknown;
      await configured(async () => {
        out = await tools.callJson("looker_search", {
          query,
          ...(limit === undefined ? {} : { limit }),
        });
      });
      return (out as { matches: { id: string }[] }).matches.map((m) => m.id);
    };
    expect(await ids("REVENUE")).toEqual(["7"]);
    expect(await ids("12")).toEqual(["12"]);
    expect(await ids("n", 1)).toEqual(["7"]);
    expect(await ids("churn")).toEqual([]);
  });

  it("names the collection and status when a read fails", async () => {
    serve({ status: 500, body: "internal error" });
    await configured(async () => {
      await expect(tools.call("looker_search", { query: "x" })).rejects.toThrow(
        "Looker /api/4.0/dashboards 500: internal error",
      );
    });
  });

  it("names the login when it fails, or when it yields no token, and reads nothing", async () => {
    const refused = serve("[]", { status: 403, body: "bad client" });
    await configured(async () => {
      await expect(tools.call("looker_get", { id: "7" })).rejects.toThrow(
        "Looker login 403: bad client",
      );
    });
    expect(refused.calls.map((c) => c.url)).toEqual([LOGIN]);

    const tokenless = serve("[]", '{"token_type":"Bearer"}');
    await configured(async () => {
      await expect(tools.call("looker_get", { id: "7" })).rejects.toThrow(
        "Looker login response missing access_token",
      );
    });
    expect(tokenless.calls.map((c) => c.url)).toEqual([LOGIN]);
  });
});
