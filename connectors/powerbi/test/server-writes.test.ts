import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { resetConnectorModeForTests, setConnectorMode } from "../../../shared/connector-mode.ts";
import type { McpListResult, ZodObjectSchema } from "../../../shared/mcp-tool-kit.ts";
import { registerPowerBiTools } from "../src/server.ts";

// These cases assert the TOOL SURFACE, not the consent gate. Gateway mode is the shape they were
// written against: the connector registers everything and executor.ts (I2) is the gate. Reset on
// BOTH sides — bun test runs many files in ONE process.
beforeEach(() => {
  resetConnectorModeForTests();
  setConnectorMode("gateway");
});
afterEach(() => {
  resetConnectorModeForTests();
});

/**
 * Minimal server for the consent kit. In gateway mode it never reads the capability surface, but
 * it DOES register through `registerTool` — so this records into the same sink the read registrar
 * fills, or the connector's write tools would vanish from the captured surface.
 */
function consentFakeServer(sink: (name: string, handler: unknown) => void): never {
  return {
    server: { getClientCapabilities: () => undefined },
    registerTool: (name: string, _cfg: unknown, handler: unknown) => {
      sink(name, handler);
      return { disable: () => undefined };
    },
    sendToolListChanged: () => undefined,
    sendLoggingMessage: () => Promise.resolve(),
  } as unknown as never;
}

type Handler = (args: unknown) => Promise<McpListResult>;

function captureTools(): Map<string, Handler> {
  const t = new Map<string, Handler>();
  registerPowerBiTools(
    <T>(n: string, _d: string, _s: ZodObjectSchema<T>, h: (a: T) => Promise<McpListResult>) =>
      t.set(n, h as Handler),
    consentFakeServer((n, h) => t.set(n, h as Handler)),
  );
  return t;
}

function payload(res: McpListResult): Record<string, unknown> {
  return JSON.parse((res.content[0] as { text: string }).text) as Record<string, unknown>;
}

describe("power bi write tools", () => {
  const origFetch = globalThis.fetch;
  let calls: { url: string; method: string; body: string }[] = [];

  beforeEach(() => {
    calls = [];
    process.env["POWERBI_TENANT_ID"] = "tenant-1";
    process.env["POWERBI_CLIENT_ID"] = "client-1";
    process.env["POWERBI_CLIENT_SECRET"] = "secret-1";
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      const u = String(url);
      if (new URL(u).hostname === "login.microsoftonline.com") {
        return new Response(JSON.stringify({ access_token: "tok" }), { status: 200 });
      }
      calls.push({
        url: u,
        method: String(init?.method),
        body: typeof init?.body === "string" ? init.body : "",
      });
      return new Response("", { status: 202 });
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = origFetch;
    delete process.env["POWERBI_TENANT_ID"];
    delete process.env["POWERBI_CLIENT_ID"];
    delete process.env["POWERBI_CLIENT_SECRET"];
  });

  it("dataset refresh with a groupId targets the group-scoped endpoint", async () => {
    const out = payload(
      await (captureTools().get("powerbi_dataset_refresh") as Handler)({
        groupId: "g1",
        datasetId: "d1",
      }),
    );
    expect(out).toEqual({ status: "queued", groupId: "g1", datasetId: "d1" });
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url).toContain("/groups/g1/datasets/d1/refreshes");
    expect(JSON.parse(calls[0]?.body ?? "{}")).toEqual({ notifyOption: "NoNotification" });
  });

  it("dataset refresh without a groupId targets the My-Workspace endpoint", async () => {
    const out = payload(
      await (captureTools().get("powerbi_dataset_refresh") as Handler)({ datasetId: "d1" }),
    );
    expect(out).toEqual({ status: "queued", datasetId: "d1" });
    expect(calls[0]?.url).toContain("/v1.0/myorg/datasets/d1/refreshes");
    expect(calls[0]?.url).not.toContain("/groups/");
  });

  it("dataset refresh accepts a null groupId (My-Workspace metadata) → My-Workspace endpoint", async () => {
    const out = payload(
      await (captureTools().get("powerbi_dataset_refresh") as Handler)({
        groupId: null,
        datasetId: "d1",
      }),
    );
    expect(out).toEqual({ status: "queued", datasetId: "d1" });
    expect(calls[0]?.url).toContain("/v1.0/myorg/datasets/d1/refreshes");
    expect(calls[0]?.url).not.toContain("/groups/");
  });

  it("dataflow refresh targets the group-scoped dataflow endpoint", async () => {
    const out = payload(
      await (captureTools().get("powerbi_dataflow_refresh") as Handler)({
        groupId: "g1",
        dataflowId: "f1",
      }),
    );
    expect(out).toEqual({ status: "queued", groupId: "g1", dataflowId: "f1" });
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url).toContain("/groups/g1/dataflows/f1/refreshes");
    expect(JSON.parse(calls[0]?.body ?? "{}")).toEqual({ notifyOption: "NoNotification" });
  });

  it("propagates a non-ok dataset refresh status as a thrown error", async () => {
    globalThis.fetch = (async (url: string) => {
      const u = String(url);
      if (new URL(u).hostname === "login.microsoftonline.com") {
        return new Response(JSON.stringify({ access_token: "tok" }), { status: 200 });
      }
      return new Response("Forbidden", { status: 403 });
    }) as unknown as typeof fetch;

    await expect(
      (captureTools().get("powerbi_dataset_refresh") as Handler)({
        groupId: "g1",
        datasetId: "d1",
      }),
    ).rejects.toThrow("403");
  });

  it("propagates a non-ok dataflow refresh status as a thrown error", async () => {
    globalThis.fetch = (async (url: string) => {
      const u = String(url);
      if (new URL(u).hostname === "login.microsoftonline.com") {
        return new Response(JSON.stringify({ access_token: "tok" }), { status: 200 });
      }
      return new Response("Forbidden", { status: 403 });
    }) as unknown as typeof fetch;

    await expect(
      (captureTools().get("powerbi_dataflow_refresh") as Handler)({
        groupId: "g1",
        dataflowId: "f1",
      }),
    ).rejects.toThrow("403");
  });

  // Both refreshes go through one request helper; these pin what it sends and the failure text,
  // which names the kind of refresh that failed.
  const REFRESHES = [
    {
      tool: "powerbi_dataset_refresh",
      args: { groupId: "g 1", datasetId: "d/1" },
      url: "https://api.powerbi.com/v1.0/myorg/groups/g%201/datasets/d%2F1/refreshes",
      what: "dataset",
    },
    {
      tool: "powerbi_dataflow_refresh",
      args: { groupId: "g 1", dataflowId: "f/1" },
      url: "https://api.powerbi.com/v1.0/myorg/groups/g%201/dataflows/f%2F1/refreshes",
      what: "dataflow",
    },
  ] as const;

  for (const { tool, args, url, what } of REFRESHES) {
    it(`${tool} POSTs with the bearer token and a JSON body to exactly ${url}`, async () => {
      const seen: { url: string; headers: Record<string, string> }[] = [];
      globalThis.fetch = (async (input: string, init?: RequestInit) => {
        const u = String(input);
        if (new URL(u).hostname === "login.microsoftonline.com") {
          return new Response(JSON.stringify({ access_token: "tok" }), { status: 200 });
        }
        seen.push({ url: u, headers: (init?.headers ?? {}) as Record<string, string> });
        return new Response("", { status: 202 });
      }) as unknown as typeof fetch;
      await (captureTools().get(tool) as Handler)(args);
      expect(seen).toEqual([
        { url, headers: { Authorization: "Bearer tok", "Content-Type": "application/json" } },
      ]);
    });

    it(`${tool} names the ${what} refresh and quotes the body on failure`, async () => {
      globalThis.fetch = (async (input: string) => {
        if (new URL(String(input)).hostname === "login.microsoftonline.com") {
          return new Response(JSON.stringify({ access_token: "tok" }), { status: 200 });
        }
        return new Response("Forbidden", { status: 403 });
      }) as unknown as typeof fetch;
      await expect((captureTools().get(tool) as Handler)(args)).rejects.toThrow(
        `Power BI ${what} refresh 403: Forbidden`,
      );
    });
  }
});
