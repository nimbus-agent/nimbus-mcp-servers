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
import { registerSplitTools, SPLIT_TOOL_NAMES } from "../src/tools.ts";

const API = "https://api.split.io/internal/api/v2";
const KEY = "fake-split-admin-key";
const WS = "ws-1234";

let tools: CapturedTools;
let http: FetchStub | undefined;

function serve(reply: StubReply | ((req: RecordedRequest) => StubReply | undefined)): FetchStub {
  http?.restore();
  http = stubFetch(reply);
  return http;
}

const configured = (fn: () => Promise<void>): Promise<void> =>
  withEnv({ SPLIT_ADMIN_API_KEY: KEY }, fn);

beforeEach(() => {
  resetConnectorModeForTests();
  setConnectorMode("gateway");
  tools = captureTools(registerSplitTools);
});

afterEach(() => {
  resetConnectorModeForTests();
  http?.restore();
  http = undefined;
});

describe("split read tools", () => {
  it("registers exactly SPLIT_TOOL_NAMES, in order", () => {
    expect(tools.registrationOrder()).toEqual([...SPLIT_TOOL_NAMES]);
  });

  it("list with no workspace lists workspaces, with the admin key as a Bearer token", async () => {
    const stub = serve('{"objects":[{"id":"ws-1234","name":"Default"}],"totalCount":1}');
    await configured(async () => {
      expect(await tools.callJson("split_list", {})).toEqual({
        objects: [{ id: "ws-1234", name: "Default" }],
        totalCount: 1,
      });
    });
    expect(`${stub.only.method} ${stub.only.url}`).toBe(`GET ${API}/workspaces`);
    expect(stub.only.headers["authorization"]).toBe(`Bearer ${KEY}`);
  });

  it("list with a workspace pages its splits, 50 at a time unless limited", async () => {
    const stub = serve('{"objects":[],"offset":0,"limit":50,"totalCount":0}');
    await configured(async () => {
      await tools.call("split_list", { workspaceId: WS });
    });
    expect(stub.only.url).toBe(`${API}/splits/ws/${WS}?offset=0&limit=50`);

    const paged = serve("{}");
    await configured(async () => {
      await tools.call("split_list", { workspaceId: WS, offset: 100, limit: 7 });
    });
    expect(paged.only.url).toBe(`${API}/splits/ws/${WS}?offset=100&limit=7`);
  });

  it("list of a workspace's environments", async () => {
    const stub = serve('[{"id":"env-1","name":"Production"}]');
    await configured(async () => {
      expect(
        await tools.callJson("split_list", { workspaceId: WS, collection: "environments" }),
      ).toEqual([{ id: "env-1", name: "Production" }]);
    });
    expect(stub.only.url).toBe(`${API}/environments/ws/${WS}`);
  });

  it("list of environments without a workspace is refused, naming the field", async () => {
    const stub = serve("{}");
    await configured(async () => {
      await expect(tools.call("split_list", { collection: "environments" })).rejects.toThrow(
        "collection 'environments' needs workspaceId",
      );
    });
    expect(stub.calls).toEqual([]);
  });

  it("get fetches one split by workspace and name", async () => {
    const stub = serve('{"name":"new_checkout"}');
    await configured(async () => {
      expect(
        await tools.callJson("split_get", { workspaceId: WS, splitName: "new_checkout" }),
      ).toEqual({ name: "new_checkout" });
    });
    expect(stub.only.url).toBe(`${API}/splits/ws/${WS}/new_checkout`);
  });

  it("get caps every list in the split: tags, flag sets, and any other array", async () => {
    serve(
      JSON.stringify({
        name: "new_checkout",
        description: "d",
        trafficType: { id: "tt", name: "user" },
        tags: Array.from({ length: 5000 }, (_, i) => ({ name: `t${String(i)}` })),
        flagSets: Array.from({ length: 60 }, (_, i) => ({ id: `fs${String(i)}` })),
      }),
    );
    await configured(async () => {
      const out = (await tools.callJson("split_get", {
        workspaceId: WS,
        splitName: "new_checkout",
      })) as Record<string, unknown>;
      expect(out["name"]).toBe("new_checkout");
      expect(out["trafficType"]).toEqual({ id: "tt", name: "user" });
      expect(out["tags"]).toHaveLength(50);
      expect(out["tagsNotShown"]).toBe(4950);
      expect(out["flagSets"]).toHaveLength(50);
      expect(out["flagSetsNotShown"]).toBe(10);
    });
  });

  it("search pages through the workspace and matches name, description and tags", async () => {
    const page = (offset: number): unknown[] =>
      Array.from({ length: offset < 100 ? 50 : 3 }, (_, i) => ({
        name: `flag_${String(offset + i)}`,
        description: offset + i === 101 ? "Checkout rollout" : "",
        tags: offset + i === 5 ? [{ name: "checkout" }, "web"] : [],
      }));
    const stub = serve((req) => {
      const offset = Number(new URL(req.url).searchParams.get("offset"));
      return JSON.stringify({ objects: page(offset), offset, limit: 50, totalCount: 103 });
    });
    await configured(async () => {
      expect(await tools.callJson("split_search", { workspaceId: WS, query: "CHECKOUT" })).toEqual({
        matches: [
          { name: "flag_5", description: "", tags: [{ name: "checkout" }, "web"] },
          { name: "flag_101", description: "Checkout rollout", tags: [] },
        ],
        scanned: 103,
      });
    });
    expect(stub.calls.map((c) => new URL(c.url).searchParams.get("offset"))).toEqual([
      "0",
      "50",
      "100",
    ]);
  });

  it("search stops at 20 pages and says the scan was truncated", async () => {
    const stub = serve((req) => {
      const offset = Number(new URL(req.url).searchParams.get("offset"));
      const objects = Array.from({ length: 50 }, (_, i) => ({ name: `f${String(offset + i)}` }));
      return JSON.stringify({ objects, offset, limit: 50, totalCount: 5000 });
    });
    await configured(async () => {
      expect(
        await tools.callJson("split_search", { workspaceId: WS, query: "f99", limit: 2 }),
      ).toEqual({ matches: [{ name: "f99" }, { name: "f990" }], scanned: 1000, truncated: true });
    });
    expect(stub.calls).toHaveLength(20);
  });

  it("definition reads one split in one environment, bounded", async () => {
    const stub = serve(
      JSON.stringify({
        name: "new_checkout",
        environment: { id: "env-1", name: "Production" },
        trafficType: { id: "tt", name: "user" },
        killed: false,
        treatments: Array.from({ length: 55 }, (_, i) => ({
          name: `t${String(i)}`,
          configurations: i === 0 ? "x".repeat(3000) : "{}",
        })),
        defaultTreatment: "off",
        baselineTreatment: "on",
        trafficAllocation: 100,
        rules: Array.from({ length: 25 }, () => ({
          buckets: [{ treatment: "on", size: 100 }],
          condition: {
            combiner: "AND",
            matchers: [
              {
                type: "WHITELIST",
                attribute: "email",
                strings: Array.from({ length: 40 }, (_, j) => `u${String(j)}@example.test`),
              },
            ],
          },
        })),
        defaultRule: [{ treatment: "off", size: 100 }],
        creationTime: 1,
        lastUpdateTime: 2,
        lastTrafficReceivedAt: 3,
      }),
    );
    await configured(async () => {
      const out = (await tools.callJson("split_definition_get", {
        workspaceId: WS,
        splitName: "new_checkout",
        environment: "Production",
      })) as {
        killed: boolean;
        defaultTreatment: string;
        treatments: Array<{ configurations: string; configurationsTruncated?: boolean }>;
        treatmentsNotShown: number;
        rules: Array<{
          condition: { matchers: Array<{ strings: string[]; stringsNotShown: number }> };
        }>;
        rulesNotShown: number;
        defaultRule: unknown;
      };
      expect(out.killed).toBe(false);
      expect(out.defaultTreatment).toBe("off");
      expect(out.treatments).toHaveLength(50);
      expect(out.treatmentsNotShown).toBe(5);
      expect(out.treatments[0]?.configurations).toHaveLength(2000);
      expect(out.treatments[0]?.configurationsTruncated).toBe(true);
      expect(out.rules).toHaveLength(20);
      expect(out.rulesNotShown).toBe(5);
      expect(out.rules[0]?.condition.matchers[0]?.strings).toHaveLength(20);
      expect(out.rules[0]?.condition.matchers[0]?.stringsNotShown).toBe(20);
      expect(out.defaultRule).toEqual([{ treatment: "off", size: 100 }]);
    });
    expect(stub.only.url).toBe(`${API}/splits/ws/${WS}/new_checkout/environments/Production`);
  });

  it("definition caps each treatment's keys and segments, with a short or a long configuration", async () => {
    const keys = Array.from({ length: 5000 }, (_, i) => `user-${String(i)}`);
    const segments = Array.from({ length: 60 }, (_, i) => `seg-${String(i)}`);
    serve(
      JSON.stringify({
        name: "new_checkout",
        killed: false,
        treatments: [
          { name: "on", configurations: "{}", keys, segments },
          { name: "off", configurations: "c".repeat(3000), keys, segments },
          { name: "plain" },
        ],
      }),
    );
    await configured(async () => {
      const out = (await tools.callJson("split_definition_get", {
        workspaceId: WS,
        splitName: "new_checkout",
        environment: "Production",
      })) as { treatments: Array<Record<string, unknown>> };
      for (const t of out.treatments.slice(0, 2)) {
        expect(t["keys"]).toHaveLength(20);
        expect(t["keysNotShown"]).toBe(4980);
        expect(t["segments"]).toHaveLength(20);
        expect(t["segmentsNotShown"]).toBe(40);
      }
      expect(out.treatments[0]?.["configurations"]).toBe("{}");
      expect(out.treatments[0]).not.toHaveProperty("configurationsTruncated");
      expect(out.treatments[1]?.["configurations"]).toHaveLength(2000);
      expect(out.treatments[1]?.["configurationsTruncated"]).toBe(true);
      expect(out.treatments[2]).toEqual({ name: "plain" });
    });
  });

  it("refuses a dot segment or path character in any id, sending nothing", async () => {
    const stub = serve("{}");
    await configured(async () => {
      // "a b" is refused here only by the workspace id: an environment name may hold an inner space.
      for (const bad of ["..", ".", "a/b", "a?b", " a", "a%2F", ""]) {
        await expect(
          tools.call("split_get", { workspaceId: "a b", splitName: "f" }),
        ).rejects.toThrow(/letters, digits/);
        await expect(tools.call("split_get", { workspaceId: bad, splitName: "f" })).rejects.toThrow(
          /letters, digits/,
        );
        await expect(
          tools.call("split_definition_get", {
            workspaceId: WS,
            splitName: "f",
            environment: bad,
          }),
        ).rejects.toThrow(/letters, digits/);
      }
    });
    expect(stub.calls).toEqual([]);
  });

  it("refuses without SPLIT_ADMIN_API_KEY before any request", async () => {
    const stub = serve("{}");
    await withEnv({ SPLIT_ADMIN_API_KEY: undefined }, async () => {
      await expect(tools.call("split_list", {})).rejects.toThrow("SPLIT_ADMIN_API_KEY is not set");
    });
    expect(stub.calls).toEqual([]);
  });

  it("ignores any base-URL override: the host is fixed", async () => {
    const stub = serve("{}");
    await withEnv(
      { SPLIT_ADMIN_API_KEY: KEY, SPLIT_API_BASE: "https://evil.test", SPLIT_BASE_URL: "x" },
      async () => {
        await tools.call("split_list", {});
      },
    );
    expect(stub.only.url).toBe(`${API}/workspaces`);
  });

  it("quotes a bounded upstream error with its status, never the key", async () => {
    serve({ status: 429, body: `slow down ${"z".repeat(2000)}` });
    await configured(async () => {
      const err = await tools.call("split_list", {}).then(
        () => undefined,
        (e: unknown) => e as Error,
      );
      expect(err?.message).toMatch(/^Split 429: slow down/);
      expect(err?.message.length).toBeLessThan(500);
      expect(err?.message).not.toContain(KEY);
    });
  });

  it("a read refuses a redirect to another origin, sending the key nowhere else", async () => {
    const stub = serve({ status: 302, headers: { Location: "https://evil.test/steal" } });
    await configured(async () => {
      await expect(tools.call("split_list", {})).rejects.toThrow(/another origin/);
    });
    expect(stub.calls.map((c) => c.url)).toEqual([`${API}/workspaces`]);
  });
});
