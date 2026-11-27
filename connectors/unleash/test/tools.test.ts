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
import { registerUnleashTools, UNLEASH_TOOL_NAMES } from "../src/tools.ts";

const ROOT = "https://unleash.example.test";
const ADMIN = `${ROOT}/api/admin`;
const TOKEN = "fake-unleash-token";

let tools: CapturedTools;
let http: FetchStub | undefined;

function serve(reply: StubReply | ((req: RecordedRequest) => StubReply | undefined)): FetchStub {
  http?.restore();
  http = stubFetch(reply);
  return http;
}

function configured(fn: () => Promise<void>, url: string = ROOT): Promise<void> {
  return withEnv({ UNLEASH_API_URL: url, UNLEASH_API_TOKEN: TOKEN }, fn);
}

beforeEach(() => {
  resetConnectorModeForTests();
  setConnectorMode("gateway");
  tools = captureTools(registerUnleashTools);
});

afterEach(() => {
  resetConnectorModeForTests();
  http?.restore();
  http = undefined;
});

describe("unleash read tools", () => {
  it("registers exactly UNLEASH_TOOL_NAMES, in order", () => {
    expect(tools.registrationOrder()).toEqual([...UNLEASH_TOOL_NAMES]);
  });

  it("list with no project lists projects, sending the bare token as Authorization", async () => {
    const stub = serve('{"version":1,"projects":[{"id":"default"}]}');
    await configured(async () => {
      expect(await tools.callJson("unleash_list", {})).toEqual({
        version: 1,
        projects: [{ id: "default" }],
      });
    });
    expect(`${stub.only.method} ${stub.only.url}`).toBe(`GET ${ADMIN}/projects`);
    expect(stub.only.headers["authorization"]).toBe(TOKEN);
    expect(stub.only.headers["accept"]).toBe("application/json");
  });

  it("list with a project returns its features, capped at limit with the rest counted", async () => {
    const features = Array.from({ length: 5 }, (_, i) => ({ name: `f${String(i)}` }));
    const stub = serve(JSON.stringify({ version: 1, features }));
    await configured(async () => {
      expect(await tools.callJson("unleash_list", { projectId: "web", limit: 2 })).toEqual({
        projectId: "web",
        features: [{ name: "f0" }, { name: "f1" }],
        total: 5,
        notShown: 3,
      });
    });
    expect(stub.only.url).toBe(`${ADMIN}/projects/web/features`);
  });

  it("list defaults to 100 features and omits notShown when nothing is cut", async () => {
    serve('{"features":[{"name":"a"}]}');
    await configured(async () => {
      expect(await tools.callJson("unleash_list", { projectId: "web" })).toEqual({
        projectId: "web",
        features: [{ name: "a" }],
        total: 1,
      });
    });
  });

  it("get fetches one feature by project and name", async () => {
    const stub = serve('{"name":"new-checkout","environments":[]}');
    await configured(async () => {
      expect(
        await tools.callJson("unleash_get", { projectId: "web", featureName: "new-checkout" }),
      ).toEqual({ name: "new-checkout", environments: [] });
    });
    expect(stub.only.url).toBe(`${ADMIN}/projects/web/features/new-checkout`);
  });

  it("get caps each environment's strategies and every constraint's values", async () => {
    const huge = Array.from({ length: 5000 }, (_, i) => `u${String(i)}`);
    serve(
      JSON.stringify({
        name: "new-checkout",
        environments: [
          {
            name: "production",
            enabled: true,
            strategies: Array.from({ length: 60 }, () => ({
              name: "flexibleRollout",
              constraints: [{ contextName: "userId", operator: "IN", values: huge }],
            })),
            variants: Array.from({ length: 70 }, (_, i) => ({ name: `v${String(i)}` })),
          },
          { name: "dev", enabled: false },
        ],
      }),
    );
    await configured(async () => {
      const out = (await tools.callJson("unleash_get", {
        projectId: "web",
        featureName: "new-checkout",
      })) as {
        name: string;
        environments: Array<{
          name: string;
          strategies?: Array<{ constraints: Array<{ values: string[]; valuesNotShown: number }> }>;
          strategiesNotShown?: number;
          variants?: unknown[];
          variantsNotShown?: number;
        }>;
      };
      expect(out.name).toBe("new-checkout");
      const prod = out.environments[0];
      expect(prod?.strategies).toHaveLength(50);
      expect(prod?.strategiesNotShown).toBe(10);
      expect(prod?.strategies?.[0]?.constraints[0]?.values).toHaveLength(20);
      expect(prod?.strategies?.[0]?.constraints[0]?.valuesNotShown).toBe(4980);
      expect(prod?.variants).toHaveLength(50);
      expect(prod?.variantsNotShown).toBe(20);
      expect(out.environments[1]).toEqual({ name: "dev", enabled: false });
    });
  });

  it("search asks the search endpoint, scoped to a project when one is given", async () => {
    const stub = serve('{"features":[{"name":"new-checkout"}],"total":1}');
    await configured(async () => {
      expect(await tools.callJson("unleash_search", { query: "check out" })).toEqual({
        matches: [{ name: "new-checkout" }],
        total: 1,
      });
    });
    const url = new URL(stub.only.url);
    expect(`${url.origin}${url.pathname}`).toBe(`${ADMIN}/search/features`);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      query: "check out",
      limit: "50",
      offset: "0",
    });

    const scoped = serve('{"features":[]}');
    await configured(async () => {
      expect(
        await tools.callJson("unleash_search", { query: "x", projectId: "web", limit: 5 }),
      ).toEqual({ matches: [] });
    });
    expect(Object.fromEntries(new URL(scoped.only.url).searchParams)).toEqual({
      query: "x",
      limit: "5",
      offset: "0",
      project: "IS:web",
    });
  });

  it("feature state reads one environment and bounds strategies, variants and values", async () => {
    const strategies = Array.from({ length: 55 }, (_, i) => ({
      name: "flexibleRollout",
      id: `s${String(i)}`,
      constraints: [
        {
          contextName: "userId",
          operator: "IN",
          values: Array.from({ length: 30 }, (_, j) => `u${String(j)}`),
        },
      ],
      parameters: { rollout: "50" },
    }));
    const stub = serve(
      JSON.stringify({
        name: "production",
        environment: "production",
        featureName: "new-checkout",
        enabled: true,
        type: "production",
        strategies,
        variants: [{ name: "a", weight: 1000 }],
        lastSeenAt: "2026-11-01T00:00:00Z",
        yes: 10,
      }),
    );
    await configured(async () => {
      const out = (await tools.callJson("unleash_feature_state_get", {
        projectId: "web",
        featureName: "new-checkout",
        environment: "production",
      })) as {
        enabled: boolean;
        strategies: Array<{ constraints: Array<{ values: string[]; valuesNotShown: number }> }>;
        strategiesNotShown: number;
        variants: unknown[];
      };
      expect(out.enabled).toBe(true);
      expect(out.strategies).toHaveLength(50);
      expect(out.strategiesNotShown).toBe(5);
      expect(out.strategies[0]?.constraints[0]?.values).toHaveLength(20);
      expect(out.strategies[0]?.constraints[0]?.valuesNotShown).toBe(10);
      expect(out.variants).toEqual([{ name: "a", weight: 1000 }]);
      expect(out).not.toHaveProperty("yes");
    });
    expect(stub.only.url).toBe(
      `${ADMIN}/projects/web/features/new-checkout/environments/production`,
    );
  });

  it("refuses a dot segment or a path character in any name, sending nothing", async () => {
    const stub = serve("{}");
    await configured(async () => {
      for (const bad of ["..", ".", "a/b", "a?b", "a b", "a%2Fb", "", "x".repeat(101)]) {
        await expect(
          tools.call("unleash_get", { projectId: bad, featureName: "f" }),
        ).rejects.toThrow();
        await expect(
          tools.call("unleash_feature_state_get", {
            projectId: "web",
            featureName: bad,
            environment: "production",
          }),
        ).rejects.toThrow();
      }
    });
    expect(stub.calls).toEqual([]);
  });

  it("accepts the instance root with or without /api, and a sub-path install", async () => {
    for (const [url, expected] of [
      [`${ROOT}/api/`, `${ADMIN}/projects`],
      [`${ROOT}//`, `${ADMIN}/projects`],
      [`${ROOT}/unleash`, `${ROOT}/unleash/api/admin/projects`],
      [`${ROOT}/unleash/api`, `${ROOT}/unleash/api/admin/projects`],
      ["http://localhost:4242", "http://localhost:4242/api/admin/projects"],
      ["http://127.0.0.1:4242", "http://127.0.0.1:4242/api/admin/projects"],
      ["http://[::1]:4242/api", "http://[::1]:4242/api/admin/projects"],
    ] as const) {
      const stub = serve("{}");
      await configured(async () => {
        await tools.call("unleash_list", {});
      }, url);
      expect(stub.only.url).toBe(expected);
    }
  });

  it("refuses a non-https UNLEASH_API_URL, naming the variable, before any request", async () => {
    const stub = serve("{}");
    for (const url of [
      "http://unleash.example.test",
      "ftp://unleash.example.test",
      "unleash.example.test",
      "http://10.0.0.5:4242",
    ]) {
      await configured(async () => {
        await expect(tools.call("unleash_list", {})).rejects.toThrow(
          /UNLEASH_API_URL must be an https URL/,
        );
      }, url);
    }
    expect(stub.calls).toEqual([]);
  });

  it("refuses credentials, a query or a fragment in UNLEASH_API_URL", async () => {
    const stub = serve("{}");
    await configured(async () => {
      await expect(tools.call("unleash_list", {})).rejects.toThrow(
        "UNLEASH_API_URL must not carry credentials",
      );
    }, "https://ada:pw@unleash.example.test");
    for (const url of [`${ROOT}?x=1`, `${ROOT}#frag`]) {
      await configured(async () => {
        await expect(tools.call("unleash_list", {})).rejects.toThrow(
          "UNLEASH_API_URL must not carry a query or a fragment",
        );
      }, url);
    }
    expect(stub.calls).toEqual([]);
  });

  it("names UNLEASH_API_URL first, then UNLEASH_API_TOKEN, before any request", async () => {
    const stub = serve("{}");
    await withEnv({ UNLEASH_API_URL: undefined, UNLEASH_API_TOKEN: undefined }, async () => {
      await expect(tools.call("unleash_list", {})).rejects.toThrow("UNLEASH_API_URL is not set");
    });
    await withEnv({ UNLEASH_API_URL: ROOT, UNLEASH_API_TOKEN: "  " }, async () => {
      await expect(tools.call("unleash_list", {})).rejects.toThrow("UNLEASH_API_TOKEN is not set");
    });
    expect(stub.calls).toEqual([]);
  });

  it("quotes a bounded upstream error with its status, never the token", async () => {
    serve({ status: 401, body: `${"denied ".repeat(200)}` });
    await configured(async () => {
      const err = await tools.call("unleash_list", {}).then(
        () => undefined,
        (e: unknown) => e as Error,
      );
      expect(err?.message).toMatch(/^Unleash 401: denied/);
      expect(err?.message.length).toBeLessThan(500);
      expect(err?.message).not.toContain(TOKEN);
    });
  });

  it("a read refuses a redirect to another origin, sending the token nowhere else", async () => {
    const stub = serve({ status: 302, headers: { Location: "https://evil.test/steal" } });
    await configured(async () => {
      await expect(tools.call("unleash_list", {})).rejects.toThrow(/another origin/);
    });
    expect(stub.calls.map((c) => c.url)).toEqual([`${ADMIN}/projects`]);
  });
});
