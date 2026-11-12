import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  type CapturedTools,
  captureTools,
  type FetchStub,
  type StubReply,
  stubFetch,
  withEnv,
} from "../../../scripts/connector-tool-harness.ts";
import { registerVantageToolsWith } from "../src/tools.ts";
import { COSTS_LAST_PAGE, COSTS_NO_LINKS, COSTS_PAGE_ONE, TEST_TOKEN } from "./fixtures.ts";

const SINCE = Date.UTC(2026, 9, 1, 13, 45); // 2026-10-01
const UNTIL = Date.UTC(2026, 10, 12, 23, 59); // 2026-11-12

let tools: CapturedTools;
let http: FetchStub | undefined;

function serve(reply: StubReply): FetchStub {
  http?.restore();
  http = stubFetch(reply);
  return http;
}

/** Run `fn` with a token and none of the optional variables, unless `extra` sets them. */
function configured(
  fn: () => Promise<void>,
  extra: Record<string, string | undefined> = {},
): Promise<void> {
  return withEnv(
    {
      VANTAGE_API_TOKEN: TEST_TOKEN,
      VANTAGE_COST_REPORT_TOKEN: undefined,
      VANTAGE_WORKSPACE_TOKEN: undefined,
      VANTAGE_GROUP_BY: undefined,
      ...extra,
    },
    fn,
  );
}

beforeEach(() => {
  tools = captureTools((reg) =>
    registerVantageToolsWith(reg, { now: () => UNTIL, sleep: async () => undefined }),
  );
});

afterEach(() => {
  http?.restore();
  http = undefined;
});

describe("vantage_cost_list", () => {
  it("sends a GET to /v2/costs with the Bearer token", async () => {
    const stub = serve(JSON.stringify(COSTS_LAST_PAGE));
    await configured(async () => {
      await tools.call("vantage_cost_list", { sinceMs: SINCE, untilMs: UNTIL });
    });
    expect(stub.only.method).toBe("GET");
    expect(new URL(stub.only.url).origin + new URL(stub.only.url).pathname).toBe(
      "https://api.vantage.sh/v2/costs",
    );
    expect(stub.only.headers["authorization"]).toBe(`Bearer ${TEST_TOKEN}`);
    expect(stub.only.headers["accept"]).toBe("application/json");
  });

  it("sends UTC dates, day bins, the default groupings, the 5000 limit and page 1", async () => {
    const stub = serve(JSON.stringify(COSTS_LAST_PAGE));
    await configured(async () => {
      await tools.call("vantage_cost_list", { sinceMs: SINCE, untilMs: UNTIL });
    });
    const q = new URL(stub.only.url).searchParams;
    expect(Object.fromEntries(q.entries())).toEqual({
      start_date: "2026-10-01",
      end_date: "2026-11-12",
      date_bin: "day",
      groupings: "provider,service,account_id",
      limit: "5000",
      page: "1",
    });
    // R1: groupings is ONE comma-joined parameter (style form, explode false).
    expect(q.getAll("groupings")).toHaveLength(1);
  });

  it("defaults the end date to now and omits the start date when sinceMs is absent", async () => {
    const stub = serve(JSON.stringify(COSTS_LAST_PAGE));
    await configured(async () => {
      await tools.call("vantage_cost_list", {});
    });
    const q = new URL(stub.only.url).searchParams;
    expect(q.get("end_date")).toBe("2026-11-12");
    expect(q.has("start_date")).toBe(false);
  });

  it("uses the saved report's groupings when a report token is set", async () => {
    const stub = serve(JSON.stringify(COSTS_LAST_PAGE));
    await configured(
      async () => {
        await tools.call("vantage_cost_list", { sinceMs: SINCE, untilMs: UNTIL });
      },
      { VANTAGE_COST_REPORT_TOKEN: "rprt_abc" },
    );
    const q = new URL(stub.only.url).searchParams;
    expect(q.get("cost_report_token")).toBe("rprt_abc");
    expect(q.has("groupings")).toBe(false);
  });

  it("lets VANTAGE_GROUP_BY override the grouping, with or without a report token", async () => {
    const withReport = serve(JSON.stringify(COSTS_LAST_PAGE));
    await configured(
      async () => {
        await tools.call("vantage_cost_list", {});
      },
      { VANTAGE_COST_REPORT_TOKEN: "rprt_abc", VANTAGE_GROUP_BY: "provider, tag:team" },
    );
    expect(new URL(withReport.only.url).searchParams.get("groupings")).toBe("provider,tag:team");

    const noReport = serve(JSON.stringify(COSTS_LAST_PAGE));
    await configured(
      async () => {
        await tools.call("vantage_cost_list", {});
      },
      { VANTAGE_GROUP_BY: "region" },
    );
    expect(new URL(noReport.only.url).searchParams.get("groupings")).toBe("region");
  });

  it("sends workspace_token when VANTAGE_WORKSPACE_TOKEN is set", async () => {
    const stub = serve(JSON.stringify(COSTS_LAST_PAGE));
    await configured(
      async () => {
        await tools.call("vantage_cost_list", {});
      },
      { VANTAGE_WORKSPACE_TOKEN: "wrkspc_abc" },
    );
    expect(new URL(stub.only.url).searchParams.get("workspace_token")).toBe("wrkspc_abc");
  });

  it("builds the query with URLSearchParams, so an env value cannot add a parameter", async () => {
    const stub = serve(JSON.stringify(COSTS_LAST_PAGE));
    await configured(
      async () => {
        await tools.call("vantage_cost_list", {});
      },
      { VANTAGE_WORKSPACE_TOKEN: "w&limit=1&evil=1" },
    );
    const q = new URL(stub.only.url).searchParams;
    expect(q.get("workspace_token")).toBe("w&limit=1&evil=1");
    expect(q.get("limit")).toBe("5000");
    expect(q.has("evil")).toBe(false);
  });

  it("honours a smaller limit and turns the cursor into a page number", async () => {
    const stub = serve(JSON.stringify(COSTS_LAST_PAGE));
    await configured(async () => {
      await tools.call("vantage_cost_list", { limit: 200, cursor: "3" });
    });
    const q = new URL(stub.only.url).searchParams;
    expect(q.get("limit")).toBe("200");
    expect(q.get("page")).toBe("3");
  });

  it("refuses a limit above 5000 and a cursor that is not a page number, before any request", async () => {
    const stub = serve(JSON.stringify(COSTS_LAST_PAGE));
    await configured(async () => {
      await expect(tools.call("vantage_cost_list", { limit: 5001 })).rejects.toThrow();
      for (const cursor of ["0", "-1", "1.5", "abc", "1234567", "https://evil.example/x", "02"]) {
        await expect(tools.call("vantage_cost_list", { cursor })).rejects.toThrow(/cursor/);
      }
    });
    expect(stub.calls).toHaveLength(0);
  });

  it("never takes a request URL from a reply: links.next is ignored", async () => {
    const stub = serve(JSON.stringify(COSTS_PAGE_ONE));
    await configured(async () => {
      await tools.call("vantage_cost_list", { cursor: "1" });
    });
    expect(stub.calls).toHaveLength(1);
    expect(new URL(stub.only.url).hostname).toBe("api.vantage.sh");
  });

  it("returns nextCursor as the next page number while links.next is a non-empty string", async () => {
    serve(JSON.stringify(COSTS_PAGE_ONE));
    await configured(async () => {
      expect(await tools.callJson("vantage_cost_list", { cursor: "4" })).toMatchObject({
        nextCursor: "5",
      });
    });
  });

  it("returns nextCursor null on the last page, with a null next, no next or no links", async () => {
    for (const body of [
      COSTS_LAST_PAGE,
      COSTS_NO_LINKS,
      { ...COSTS_LAST_PAGE, links: { next: "" } },
    ]) {
      serve(JSON.stringify(body));
      await configured(async () => {
        const out = (await tools.callJson("vantage_cost_list", {})) as { nextCursor: unknown };
        expect(out.nextCursor).toBeNull();
      });
    }
  });

  it("returns the reply's costs array untouched as items", async () => {
    serve(JSON.stringify(COSTS_PAGE_ONE));
    await configured(async () => {
      const out = (await tools.callJson("vantage_cost_list", {})) as { items: unknown };
      expect(out.items).toEqual(COSTS_PAGE_ONE.costs as unknown as unknown[]);
    });
  });

  it("returns an empty items array when the reply has no costs array", async () => {
    serve("{}");
    await configured(async () => {
      expect(await tools.callJson("vantage_cost_list", {})).toEqual({
        items: [],
        nextCursor: null,
      });
    });
  });

  it("throws `Vantage <status>: <snippet>` on a non-2xx reply", async () => {
    serve({ status: 500, body: "boom" });
    await configured(async () => {
      await expect(tools.call("vantage_cost_list", {})).rejects.toThrow("Vantage 500: boom");
    });
  });

  it("names VANTAGE_API_TOKEN and sends nothing when the token is unset", async () => {
    const stub = serve(JSON.stringify(COSTS_LAST_PAGE));
    await configured(
      async () => {
        await expect(tools.call("vantage_cost_list", {})).rejects.toThrow(
          "VANTAGE_API_TOKEN is not set",
        );
      },
      { VANTAGE_API_TOKEN: undefined },
    );
    expect(stub.calls).toHaveLength(0);
  });
});
