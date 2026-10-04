import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  type CapturedTools,
  captureTools,
  type FetchStub,
  type StubReply,
  stubFetch,
  withEnv,
} from "../../../scripts/connector-tool-harness.ts";
import { registerWorkdayTools } from "../src/server.ts";

const API = "https://wd5.workday.example/ccx/api/staffing/v6/acme%20corp";

const WORKERS = {
  data: [
    {
      id: "w1",
      descriptor: "Ada Lovelace",
      title: "Principal Engineer",
      team: "Compilers",
      department: "R&D",
      location: "London",
    },
    {
      id: "w2",
      descriptor: "Grace Hopper",
      title: "Rear Admiral",
      team: "Navy",
      department: "Operations",
      location: "Arlington",
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

/** A tenant whose name needs encoding, on a host given with a trailing slash. */
function configured(fn: () => Promise<void>): Promise<void> {
  return withEnv(
    {
      WORKDAY_TENANT_HOST: "https://wd5.workday.example/",
      WORKDAY_TENANT: "acme corp",
      WORKDAY_ACCESS_TOKEN: "wd-token",
    },
    fn,
  );
}

beforeEach(() => {
  tools = captureTools(registerWorkdayTools);
});

afterEach(() => {
  http?.restore();
  http = undefined;
});

describe("workday reads", () => {
  it("list asks the tenant's staffing API for 100 workers by default", async () => {
    const stub = serve(JSON.stringify(WORKERS));
    await configured(async () => {
      expect(await tools.callJson("workday_list", {})).toEqual(WORKERS);
    });
    expect(stub.only.url).toBe(`${API}/workers?limit=100`);
    expect(stub.only.headers["authorization"]).toBe("Bearer wd-token");
  });

  it("list honours `limit`, and get addresses one worker by its encoded id", async () => {
    const limited = serve('{"data":[]}');
    await configured(async () => {
      await tools.call("workday_list", { limit: 5 });
    });
    expect(limited.only.url).toBe(`${API}/workers?limit=5`);

    const one = serve('{"id":"w/1"}');
    await configured(async () => {
      expect(await tools.callJson("workday_get", { id: "w/1" })).toEqual({ id: "w/1" });
    });
    expect(one.only.url).toBe(`${API}/workers/w%2F1`);
  });

  it("search matches name, title, team, department and location in the first page", async () => {
    const stub = serve(JSON.stringify(WORKERS));
    const ids = async (query: string, limit?: number): Promise<unknown[]> => {
      let out: unknown;
      await configured(async () => {
        out = await tools.callJson("workday_search", {
          query,
          ...(limit === undefined ? {} : { limit }),
        });
      });
      return (out as { matches: { id: string }[] }).matches.map((m) => m.id);
    };
    expect(await ids("LOVELACE")).toEqual(["w1"]);
    expect(await ids("admiral")).toEqual(["w2"]);
    expect(await ids("compilers")).toEqual(["w1"]);
    expect(await ids("operations")).toEqual(["w2"]);
    expect(await ids("arlington")).toEqual(["w2"]);
    expect(await ids("a", 1)).toEqual(["w1"]);
    expect(await ids("berlin")).toEqual([]);
    expect(stub.calls[0]?.url).toBe(`${API}/workers?limit=100`);
  });

  it("search finds nothing in an answer that carries no data array", async () => {
    serve('{"total":0}');
    await configured(async () => {
      expect(await tools.callJson("workday_search", { query: "x" })).toEqual({ matches: [] });
    });
  });

  it("quotes Workday's status and body when a request fails", async () => {
    serve({ status: 401, body: "invalid_token" });
    await configured(async () => {
      await expect(tools.call("workday_get", { id: "w1" })).rejects.toThrow(
        "Workday 401: invalid_token",
      );
    });
  });

  it("names the missing configuration, and sends nothing, when the tenant is not set up", async () => {
    const stub = serve("{}");
    for (const missing of ["WORKDAY_TENANT_HOST", "WORKDAY_TENANT", "WORKDAY_ACCESS_TOKEN"]) {
      await configured(async () => {
        await withEnv({ [missing]: undefined }, async () => {
          await expect(tools.call("workday_search", { query: "x" })).rejects.toThrow(
            `${missing} is not set`,
          );
        });
      });
    }
    expect(stub.calls).toEqual([]);
  });
});
