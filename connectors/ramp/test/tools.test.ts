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
import { __resetRampTokenForTests, RAMP_TOOL_NAMES, registerRampTools } from "../src/tools.ts";

const API = "https://api.ramp.com";
const TOKEN_URL = `${API}/developer/v1/token`;
const TOKEN = '{"access_token":"ramp-access","token_type":"Bearer"}';

const TRANSACTIONS = {
  data: [
    {
      id: "t1",
      merchant_name: "Acme Cloud",
      sk_category_name: "Software",
      state: "CLEARED",
      currency_code: "USD",
      memo: "Annual plan",
      card_holder: { first_name: "Ada", last_name: "Lovelace", department_name: "Engineering" },
    },
    {
      id: "t2",
      merchant_name: "Cafe Uno",
      sk_category_name: "Meals",
      state: "PENDING",
      currency_code: "EUR",
      memo: "",
      card_holder: null,
    },
  ],
};

let tools: CapturedTools;
let http: FetchStub | undefined;

/** Answer the token endpoint with `token`, and the transactions API with `api`. */
function serve(api: StubReply, token: StubReply = TOKEN): FetchStub {
  http?.restore();
  http = stubFetch((req: RecordedRequest) => (req.url === TOKEN_URL ? token : api));
  return http;
}

function configured(fn: () => Promise<void>): Promise<void> {
  return withEnv({ RAMP_CLIENT_ID: "client-id", RAMP_CLIENT_SECRET: "client-secret" }, fn);
}

beforeEach(() => {
  __resetRampTokenForTests();
  tools = captureTools(registerRampTools);
});

afterEach(() => {
  http?.restore();
  http = undefined;
  __resetRampTokenForTests();
});

describe("ramp tools", () => {
  it("registers exactly RAMP_TOOL_NAMES", () => {
    expect(tools.names()).toEqual([...RAMP_TOOL_NAMES]);
  });

  it("exchanges the client credentials once, then sends the bearer token on every call", async () => {
    const stub = serve(JSON.stringify(TRANSACTIONS));
    await configured(async () => {
      expect(await tools.callJson("ramp_list", {})).toEqual(TRANSACTIONS.data);
      await tools.call("ramp_get", { id: "t/1" });
    });
    expect(stub.calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      `POST ${TOKEN_URL}`,
      `GET ${API}/developer/v1/transactions?page_size=100`,
      `GET ${API}/developer/v1/transactions/t%2F1`,
    ]);
    const [exchange, list] = stub.calls;
    expect(exchange?.headers["authorization"]).toBe(`Basic ${btoa("client-id:client-secret")}`);
    expect(exchange?.headers["content-type"]).toBe("application/x-www-form-urlencoded");
    expect(Object.fromEntries(new URLSearchParams(exchange?.body ?? ""))).toEqual({
      grant_type: "client_credentials",
      scope: "transactions:read",
    });
    expect(list?.headers["authorization"]).toBe("Bearer ramp-access");
  });

  it("list honours `limit` as the page size", async () => {
    const stub = serve('{"data":[]}');
    await configured(async () => {
      expect(await tools.callJson("ramp_list", { limit: 5 })).toEqual([]);
    });
    expect(stub.calls[1]?.url).toBe(`${API}/developer/v1/transactions?page_size=5`);
  });

  it("list answers an empty list when the response carries no data array", async () => {
    serve('{"page":{"next":null}}');
    await configured(async () => {
      expect(await tools.callJson("ramp_list", {})).toEqual([]);
    });
  });

  it("search matches merchant, category, state, currency, memo and the card holder", async () => {
    const stub = serve(JSON.stringify(TRANSACTIONS));
    const ids = async (query: string, limit?: number): Promise<unknown[]> => {
      let out: unknown;
      await configured(async () => {
        out = await tools.callJson("ramp_search", {
          query,
          ...(limit === undefined ? {} : { limit }),
        });
      });
      return (out as { matches: { id: string }[] }).matches.map((m) => m.id);
    };
    expect(await ids("ACME")).toEqual(["t1"]);
    expect(await ids("meals")).toEqual(["t2"]);
    expect(await ids("pending")).toEqual(["t2"]);
    expect(await ids("eur")).toEqual(["t2"]);
    expect(await ids("annual")).toEqual(["t1"]);
    expect(await ids("lovelace engineering")).toEqual(["t1"]);
    expect(await ids("c", 1)).toEqual(["t1"]);
    expect(stub.calls.filter((c) => c.url !== TOKEN_URL).map((c) => c.url)[0]).toBe(
      `${API}/developer/v1/transactions?page_size=100`,
    );
  });

  it("quotes the API's status and body when a request fails", async () => {
    serve({ status: 404, body: "transaction not found" });
    await configured(async () => {
      await expect(tools.call("ramp_get", { id: "nope" })).rejects.toThrow(
        "Ramp 404: transaction not found",
      );
    });
  });

  it("names the token exchange, and sends nothing else, when it is refused", async () => {
    const stub = serve("{}", { status: 401, body: "invalid_client" });
    await configured(async () => {
      await expect(tools.call("ramp_list", {})).rejects.toThrow(
        "Ramp token exchange 401: invalid_client",
      );
    });
    expect(stub.calls.map((c) => c.url)).toEqual([TOKEN_URL]);
  });

  it("refuses without client credentials, before any request", async () => {
    const stub = serve("{}");
    for (const [missing, env] of [
      ["RAMP_CLIENT_ID", { RAMP_CLIENT_ID: undefined, RAMP_CLIENT_SECRET: "s" }],
      ["RAMP_CLIENT_SECRET", { RAMP_CLIENT_ID: "i", RAMP_CLIENT_SECRET: " " }],
    ] as const) {
      await withEnv(env, async () => {
        await expect(tools.call("ramp_list", {})).rejects.toThrow(`${missing} is not set`);
      });
    }
    expect(stub.calls).toEqual([]);
  });
});
