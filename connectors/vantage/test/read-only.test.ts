import { afterEach, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  captureTools,
  type FetchStub,
  stubFetch,
  withEnv,
} from "../../../scripts/connector-tool-harness.ts";
import { fixtureFor, type ParsableSchema } from "../../../scripts/tool-arg-fixture.ts";
import { registerVantageToolsWith, VANTAGE_TOOL_NAMES } from "../src/tools.ts";
import { COST_REPORT, COSTS_LAST_PAGE, RECOMMENDATIONS_LAST_PAGE, TEST_TOKEN } from "./fixtures.ts";

const HERE = resolve(fileURLToPath(import.meta.url), "..");
const MANIFEST = JSON.parse(readFileSync(resolve(HERE, "../nimbus.extension.json"), "utf8")) as {
  permissions: { network: string[] };
  hitlRequired: string[];
};

let http: FetchStub | undefined;

afterEach(() => {
  http?.restore();
  http = undefined;
});

function surface() {
  return captureTools((reg) =>
    registerVantageToolsWith(reg, { now: () => 0, sleep: async () => undefined }),
  );
}

function replyByPath(req: { url: string }): string {
  const path = new URL(req.url).pathname;
  if (path === "/v2/costs") return JSON.stringify(COSTS_LAST_PAGE);
  if (path === "/v2/recommendations") return JSON.stringify(RECOMMENDATIONS_LAST_PAGE);
  return JSON.stringify(COST_REPORT);
}

describe("the Vantage surface is read-only", () => {
  it("registers exactly the four documented tools, in order", () => {
    expect(surface().registrationOrder()).toEqual([...VANTAGE_TOOL_NAMES]);
    expect([...VANTAGE_TOOL_NAMES]).toEqual([
      "vantage_cost_list",
      "vantage_recommendation_list",
      "vantage_cost_get",
      "vantage_search",
    ]);
  });

  it("sends only GET requests, to api.vantage.sh/v2, each carrying the Bearer token", async () => {
    const tools = surface();
    const stub = stubFetch(replyByPath);
    http = stub;
    await withEnv({ VANTAGE_API_TOKEN: TEST_TOKEN }, async () => {
      for (const name of tools.names()) {
        const args = fixtureFor(tools.get(name).schema as ParsableSchema);
        expect(args).toBeDefined();
        await tools.call(name, args);
      }
    });
    expect(stub.calls.length).toBeGreaterThanOrEqual(VANTAGE_TOOL_NAMES.length);
    for (const req of stub.calls) {
      expect(req.method).toBe("GET");
      expect(req.body).toBeUndefined();
      expect(req.url.startsWith("https://api.vantage.sh/v2/")).toBe(true);
      expect(req.headers["authorization"]).toBe(`Bearer ${TEST_TOKEN}`);
    }
  });

  it("works with only VANTAGE_API_TOKEN set, and refuses by name before any request without it", async () => {
    const tools = surface();
    const stub = stubFetch(replyByPath);
    http = stub;
    const optional = {
      VANTAGE_COST_REPORT_TOKEN: undefined,
      VANTAGE_WORKSPACE_TOKEN: undefined,
      VANTAGE_GROUP_BY: undefined,
    };
    await withEnv({ ...optional, VANTAGE_API_TOKEN: TEST_TOKEN }, async () => {
      await tools.call("vantage_cost_list", {});
    });
    expect(stub.calls).toHaveLength(1);
    await withEnv({ ...optional, VANTAGE_API_TOKEN: undefined }, async () => {
      for (const name of tools.names()) {
        const args = fixtureFor(tools.get(name).schema as ParsableSchema);
        await expect(tools.call(name, args)).rejects.toThrow("VANTAGE_API_TOKEN is not set");
      }
    });
    expect(stub.calls).toHaveLength(1);
  });
});

describe("the manifest", () => {
  it("declares no HITL action and exactly one network host, without a wildcard", () => {
    expect(MANIFEST.hitlRequired).toEqual([]);
    expect(MANIFEST.permissions.network).toEqual(["api.vantage.sh"]);
  });
});

describe("the token never leaves in an error", () => {
  it("is absent from a 401 error whose body does not echo it", async () => {
    const tools = surface();
    http = stubFetch({ status: 401, body: '{"errors":["Unauthorized"]}' });
    await withEnv({ VANTAGE_API_TOKEN: TEST_TOKEN }, async () => {
      for (const name of tools.names()) {
        const args = fixtureFor(tools.get(name).schema as ParsableSchema);
        const error = await tools.call(name, args).then(
          () => undefined,
          (e: unknown) => e as Error,
        );
        expect(error?.message).toContain("Vantage 401");
        expect(error?.message).not.toContain(TEST_TOKEN);
      }
    });
  });

  it("is only cut to 400 characters, not redacted, when a server echoes it (documented, not claimed)", async () => {
    const tools = surface();
    const body = `${"x".repeat(500)}${TEST_TOKEN}`;
    http = stubFetch({ status: 500, body });
    await withEnv({ VANTAGE_API_TOKEN: TEST_TOKEN }, async () => {
      const error = await tools.call("vantage_cost_get", { id: "a" }).then(
        () => undefined,
        (e: unknown) => e as Error,
      );
      // The getter truncates the snippet; it does not scrub it. The token here sits past the cut.
      expect(error?.message.length).toBeLessThanOrEqual("Vantage 500: ".length + 400);
    });
  });
});

describe("the source", () => {
  it("imports neither the write registrar nor the consent kit", () => {
    const source = readFileSync(resolve(HERE, "../src/tools.ts"), "utf8");
    expect(source).not.toContain("createWriteToolRegistrar");
    expect(source).not.toContain("consent-kit");
  });
});
