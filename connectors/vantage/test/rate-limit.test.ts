import { afterEach, describe, expect, it } from "bun:test";
import {
  captureTools,
  type FetchStub,
  stubFetch,
  withEnv,
} from "../../../scripts/connector-tool-harness.ts";
import { registerVantageToolsWith } from "../src/tools.ts";
import { COST_REPORT, COSTS_LAST_PAGE, RECOMMENDATIONS_LAST_PAGE, TEST_TOKEN } from "./fixtures.ts";

let http: FetchStub | undefined;

afterEach(() => {
  http?.restore();
  http = undefined;
});

/** A clock the test moves, and a sleep that records its argument and advances that clock. */
function fakeClock(start = 1_000_000) {
  let t = start;
  const slept: number[] = [];
  return {
    slept,
    advance: (ms: number): void => {
      t += ms;
    },
    deps: {
      now: (): number => t,
      sleep: async (ms: number): Promise<void> => {
        slept.push(ms);
        t += ms;
      },
    },
  };
}

function replyByPath(req: { url: string }): string {
  const path = new URL(req.url).pathname;
  if (path === "/v2/costs") return JSON.stringify(COSTS_LAST_PAGE);
  if (path === "/v2/recommendations") return JSON.stringify(RECOMMENDATIONS_LAST_PAGE);
  return JSON.stringify(COST_REPORT);
}

const ENV = { VANTAGE_API_TOKEN: TEST_TOKEN };

describe("pacing GET /costs", () => {
  it("never sleeps before the first cost request", async () => {
    const clock = fakeClock();
    const tools = captureTools((reg) => registerVantageToolsWith(reg, clock.deps));
    http = stubFetch(replyByPath);
    await withEnv(ENV, async () => {
      await tools.call("vantage_cost_list", {});
    });
    expect(clock.slept).toEqual([]);
  });

  it("makes the second cost request wait until 1200 ms after the first", async () => {
    const clock = fakeClock();
    const tools = captureTools((reg) => registerVantageToolsWith(reg, clock.deps));
    http = stubFetch(replyByPath);
    await withEnv(ENV, async () => {
      await tools.call("vantage_cost_list", {});
      clock.advance(200);
      await tools.call("vantage_cost_list", {});
    });
    expect(clock.slept).toEqual([1000]);
  });

  it("does not sleep when 1200 ms have already passed", async () => {
    const clock = fakeClock();
    const tools = captureTools((reg) => registerVantageToolsWith(reg, clock.deps));
    http = stubFetch(replyByPath);
    await withEnv(ENV, async () => {
      await tools.call("vantage_cost_list", {});
      clock.advance(1200);
      await tools.call("vantage_cost_list", {});
    });
    expect(clock.slept).toEqual([]);
  });

  it("does not pace recommendations or cost reports, even right after a cost request", async () => {
    const clock = fakeClock();
    const tools = captureTools((reg) => registerVantageToolsWith(reg, clock.deps));
    http = stubFetch(replyByPath);
    await withEnv(ENV, async () => {
      await tools.call("vantage_cost_list", {});
      await tools.call("vantage_recommendation_list", {});
      await tools.call("vantage_search", { query: "x" });
      await tools.call("vantage_cost_get", { id: "abc" });
      // /cost_reports/... must not be mistaken for /costs.
      await tools.call("vantage_cost_get", { id: "costs" });
    });
    expect(clock.slept).toEqual([]);
    expect(http.calls).toHaveLength(5);
  });
});

describe("a 429", () => {
  it("stops after one request, names the reset time and the service, and does not retry", async () => {
    const clock = fakeClock();
    const tools = captureTools((reg) => registerVantageToolsWith(reg, clock.deps));
    const stub = stubFetch({
      status: 429,
      body: "slow down",
      headers: { "x-rate-limit-reset": "1800000000" },
    });
    http = stub;
    await withEnv(ENV, async () => {
      const error = await tools.call("vantage_cost_list", {}).then(
        () => undefined,
        (e: unknown) => e as Error,
      );
      expect(error).toBeInstanceOf(Error);
      expect(error?.message).toContain("Vantage");
      expect(error?.message).toContain("429");
      expect(error?.message).toContain(new Date(1_800_000_000 * 1000).toISOString());
      expect(error?.message).not.toContain(TEST_TOKEN);
    });
    expect(stub.calls).toHaveLength(1);
    expect(clock.slept).toEqual([]);
  });

  it("applies to every endpoint, not only /costs", async () => {
    const clock = fakeClock();
    const tools = captureTools((reg) => registerVantageToolsWith(reg, clock.deps));
    const stub = stubFetch({ status: 429, headers: { "x-rate-limit-reset": "1800000000" } });
    http = stub;
    await withEnv(ENV, async () => {
      await expect(tools.call("vantage_recommendation_list", {})).rejects.toThrow(/Vantage 429/);
      await expect(tools.call("vantage_cost_get", { id: "x" })).rejects.toThrow(/Vantage 429/);
    });
    expect(stub.calls).toHaveLength(2);
  });

  it("still throws when the reset header is missing or not a number, saying it is unknown", async () => {
    for (const headers of [
      undefined,
      { "x-rate-limit-reset": "soon" },
      { "x-rate-limit-reset": "" },
    ]) {
      const tools = captureTools((reg) => registerVantageToolsWith(reg, fakeClock().deps));
      http?.restore();
      http = stubFetch({ status: 429, ...(headers === undefined ? {} : { headers }) });
      await withEnv(ENV, async () => {
        await expect(tools.call("vantage_cost_list", {})).rejects.toThrow(
          /429.*reset time.*unknown/s,
        );
      });
    }
  });

  it("does not echo the response body or the token", async () => {
    const tools = captureTools((reg) => registerVantageToolsWith(reg, fakeClock().deps));
    http = stubFetch({ status: 429, body: `token ${TEST_TOKEN} is limited` });
    await withEnv(ENV, async () => {
      const error = await tools.call("vantage_cost_list", {}).then(
        () => undefined,
        (e: unknown) => e as Error,
      );
      expect(error?.message).not.toContain(TEST_TOKEN);
    });
  });
});
