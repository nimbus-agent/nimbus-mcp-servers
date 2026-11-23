/**
 * The Allocation reader the `opencost` and `kubecost` connectors share, driven through each
 * connector's own API description. Reply shapes are the documented ones (UNVERIFIED against a
 * running instance).
 */
import { afterEach, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { KUBECOST_API, KUBECOST_TOOL_NAMES } from "../connectors/kubecost/src/tools.ts";
import { OPENCOST_API, OPENCOST_TOOL_NAMES } from "../connectors/opencost/src/tools.ts";
import { registerAllocationTools } from "../shared/k8s-allocation.ts";
import { captureTools, type FetchStub, stubFetch, withEnv } from "./connector-tool-harness.ts";
import { KUBECOST_BASE, ODD_REPLY, OPENCOST_BASE, TWO_DAYS } from "./k8s-allocation-fixtures.ts";

const ROOT = join(fileURLToPath(import.meta.url), "..", "..");
const NOW = Date.UTC(2026, 10, 22, 10, 30);

const CASES = [
  {
    id: "opencost",
    api: OPENCOST_API,
    names: OPENCOST_TOOL_NAMES,
    base: OPENCOST_BASE,
    urlEnv: "OPENCOST_URL",
    tokenEnv: "OPENCOST_TOKEN",
    path: "/allocation",
    idle: "includeIdle",
    step: true,
  },
  {
    id: "kubecost",
    api: KUBECOST_API,
    names: KUBECOST_TOOL_NAMES,
    base: KUBECOST_BASE,
    urlEnv: "KUBECOST_URL",
    tokenEnv: "KUBECOST_TOKEN",
    path: "/model/allocation",
    idle: "idle",
    step: false,
  },
] as const;

interface Body {
  items: {
    date: string;
    key: string;
    totalCost: number;
    cpuCost: number;
    properties: Record<string, string>;
  }[];
  skipped: number;
  truncated: boolean;
}

function bodyOf(result: unknown): Body {
  return JSON.parse(String((result as { content: { text: string }[] }).content[0]?.text)) as Body;
}

let http: FetchStub | undefined;
afterEach(() => {
  http?.restore();
  http = undefined;
});

for (const c of CASES) {
  describe(`${c.id}_allocation_list`, () => {
    const tool = `${c.id}_allocation_list`;
    const surface = () =>
      captureTools((reg) => registerAllocationTools(reg, { ...c.api, now: () => NOW }));
    const env = (extra: Record<string, string | undefined> = {}) => ({
      [c.urlEnv]: c.base,
      [c.tokenEnv]: undefined,
      ...extra,
    });

    it("registers exactly one tool", () => {
      expect(surface().registrationOrder()).toEqual([...c.names]);
    });

    it("sends one GET with a UTC-midnight window", async () => {
      const tools = surface();
      http = stubFetch(JSON.stringify(TWO_DAYS));
      await withEnv(env({ [c.urlEnv]: `${c.base}/` }), () => tools.call(tool, {}));
      const req = http.only;
      expect(req.method).toBe("GET");
      expect(req.body).toBeUndefined();
      const url = new URL(req.url);
      expect(url.origin + url.pathname).toBe(`${c.base}${c.path}`);
      expect(url.searchParams.get("window")).toBe(
        `${String(Date.UTC(2026, 10, 15) / 1000)},${String(NOW / 1000)}`,
      );
      expect(url.searchParams.get("aggregate")).toBe("namespace");
      expect(url.searchParams.get("accumulate")).toBe("false");
      expect(url.searchParams.get(c.idle)).toBe("false");
      expect(url.searchParams.get("step")).toBe(c.step ? "1d" : null);
      expect(req.headers["authorization"]).toBeUndefined();
    });

    it("flattens each set into one row per allocation per day", async () => {
      const tools = surface();
      http = stubFetch(JSON.stringify(TWO_DAYS));
      const body = bodyOf(await withEnv(env(), () => tools.call(tool, {})));
      expect(body.items.map((i) => [i.date, i.key, i.totalCost])).toEqual([
        ["2026-11-20", "default", 2],
        ["2026-11-20", "kube-system", 3.25],
        ["2026-11-21", "default", 3],
      ]);
      expect(body.items[0]?.properties).toEqual({
        cluster: "default-cluster",
        namespace: "default",
      });
      expect(body.skipped).toBe(0);
      expect(body.truncated).toBe(false);
    });

    it("sends the optional bearer token only when set, and passes idle and aggregate", async () => {
      const tools = surface();
      http = stubFetch(JSON.stringify(TWO_DAYS));
      await withEnv(env({ [c.tokenEnv]: "tok-1" }), () =>
        tools.call(tool, { includeIdle: true, aggregate: "label:app" }),
      );
      expect(http.only.headers["authorization"]).toBe("Bearer tok-1");
      const url = new URL(http.only.url);
      expect(url.searchParams.get(c.idle)).toBe("true");
      expect(url.searchParams.get("aggregate")).toBe("label:app");
    });

    it("zeroes undocumented numbers and counts rows it cannot date", async () => {
      const tools = surface();
      http = stubFetch(JSON.stringify(ODD_REPLY));
      const body = bodyOf(await withEnv(env(), () => tools.call(tool, {})));
      expect(body.items).toEqual([
        expect.objectContaining({ key: "odd", totalCost: 0, cpuCost: 0 }),
      ]);
      expect(body.skipped).toBe(2);
    });

    it("cuts at limit and says so", async () => {
      const tools = surface();
      http = stubFetch(JSON.stringify(TWO_DAYS));
      const body = bodyOf(await withEnv(env(), () => tools.call(tool, { limit: 2 })));
      expect(body.items).toHaveLength(2);
      expect(body.truncated).toBe(true);
    });

    it("refuses a bad window before any request, and a non-200 code or HTTP status after one", async () => {
      const tools = surface();
      http = stubFetch(JSON.stringify({ code: 500, data: null }));
      await withEnv(env(), async () => {
        await expect(tools.call(tool, { sinceMs: 0, untilMs: NOW })).rejects.toThrow(
          "may not exceed 62 days",
        );
        await expect(
          tools.call(tool, { sinceMs: NOW, untilMs: Date.UTC(2026, 10, 21) }),
        ).rejects.toThrow("after sinceMs");
        expect(http?.calls).toHaveLength(0);
        await expect(tools.call(tool, {})).rejects.toThrow("500");
      });
      http.restore();
      http = stubFetch({ status: 503, body: "down" });
      await withEnv(env(), async () => {
        await expect(tools.call(tool, {})).rejects.toThrow("503");
      });
    });

    it("refuses a URL that is not a plain http(s) base, naming the variable", async () => {
      const tools = surface();
      http = stubFetch(JSON.stringify(TWO_DAYS));
      for (const bad of [
        "ftp://x",
        "http://u:p@h:9003",
        "http://h:9003/?a=1",
        "http://h/#f",
        "nope",
      ]) {
        await withEnv(env({ [c.urlEnv]: bad }), async () => {
          await expect(tools.call(tool, {})).rejects.toThrow(c.urlEnv);
        });
      }
      await withEnv(env({ [c.urlEnv]: undefined }), async () => {
        await expect(tools.call(tool, {})).rejects.toThrow(`${c.urlEnv} is not set`);
      });
      expect(http.calls).toHaveLength(0);
    });

    it("accepts only a plain aggregate or label:/annotation:<name>", () => {
      const schema = surface().get(tool).schema as {
        safeParse: (v: unknown) => { success: boolean };
      };
      expect(schema.safeParse({ aggregate: "namespace,pod" }).success).toBe(false);
      expect(schema.safeParse({ aggregate: "label:" }).success).toBe(false);
      expect(schema.safeParse({ aggregate: "label:team" }).success).toBe(true);
    });

    it("is read-only: no HITL action, no static host, no consent kit", () => {
      const manifest = JSON.parse(
        readFileSync(join(ROOT, "connectors", c.id, "nimbus.extension.json"), "utf8"),
      ) as { permissions: { network: string[] }; hitlRequired: string[] };
      expect(manifest.hitlRequired).toEqual([]);
      expect(manifest.permissions.network).toEqual([]);
      const source = readFileSync(join(ROOT, "shared", "k8s-allocation.ts"), "utf8");
      expect(source).not.toContain("createWriteToolRegistrar");
      expect(source).not.toContain("consent-kit");
    });
  });
}
