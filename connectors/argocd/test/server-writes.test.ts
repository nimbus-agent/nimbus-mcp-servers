import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  captureStandaloneTools,
  stubFetch,
  withEnv,
} from "../../../scripts/connector-tool-harness.ts";
import { resetConnectorModeForTests, setConnectorMode } from "../../../shared/connector-mode.ts";
import type { McpListResult, ZodObjectSchema } from "../../../shared/mcp-tool-kit.ts";
import { registerArgocdTools } from "../src/server.ts";

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
  const tools = new Map<string, Handler>();
  registerArgocdTools(
    <T>(n: string, _d: string, _s: ZodObjectSchema<T>, h: (a: T) => Promise<McpListResult>) =>
      tools.set(n, h as Handler),
    consentFakeServer((n, h) => tools.set(n, h as Handler)),
  );
  return tools;
}

function payload(res: McpListResult): Record<string, unknown> {
  return JSON.parse((res.content[0] as { text: string }).text) as Record<string, unknown>;
}

describe("argocd write tools", () => {
  const origFetch = globalThis.fetch;
  let calls: { url: string; init?: RequestInit }[] = [];

  beforeEach(() => {
    calls = [];
    process.env["ARGOCD_URL"] = "https://argo.example.com";
    process.env["ARGOCD_TOKEN"] = "tok";
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify({ metadata: { name: "web" } }), { status: 200 });
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = origFetch;
    delete process.env["ARGOCD_URL"];
    delete process.env["ARGOCD_TOKEN"];
  });

  it("argocd_app_sync POSTs /applications/{name}/sync and returns status:requested", async () => {
    const out = payload(await (captureTools().get("argocd_app_sync") as Handler)({ name: "web" }));
    expect(out["status"]).toBe("requested");
    expect(calls[0]?.url).toBe("https://argo.example.com/api/v1/applications/web/sync");
    expect(calls[0]?.init?.method).toBe("POST");
  });

  it("argocd_app_sync forwards optional prune/revision into the body", async () => {
    await (captureTools().get("argocd_app_sync") as Handler)({
      name: "web",
      prune: true,
      revision: "abc123",
    });
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ prune: true, revision: "abc123" });
  });

  it("argocd_app_rollback POSTs /applications/{name}/rollback with the history id", async () => {
    await (captureTools().get("argocd_app_rollback") as Handler)({ name: "web", id: 3 });
    expect(calls[0]?.url).toBe("https://argo.example.com/api/v1/applications/web/rollback");
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ id: 3 });
  });

  it("argocd_app_sync throws on a non-2xx", async () => {
    globalThis.fetch = (async () =>
      new Response("forbidden", { status: 403 })) as unknown as typeof fetch;
    await expect(
      (captureTools().get("argocd_app_sync") as Handler)({ name: "web" }),
    ).rejects.toThrow(/403/);
  });
});

describe("argocd write scope (standalone mode)", () => {
  beforeEach(() => {
    resetConnectorModeForTests();
    setConnectorMode("standalone");
  });

  it("reads the documented NIMBUS_MCP_ARGOCD_WRITE_SCOPE", async () => {
    const http = stubFetch('{"metadata":{"name":"web"}}');
    try {
      await withEnv(
        {
          NIMBUS_MCP_ARGOCD_WRITE_SCOPE: "app:web",
          NIMBUS_MCP_AUDIT_LOG: undefined,
          ARGOCD_URL: "https://argo.example.com",
          ARGOCD_TOKEN: "tok",
        },
        async () => {
          const { tools, prompts } = captureStandaloneTools(registerArgocdTools, {
            elicitation: true,
          });
          expect(await tools.callJson("argocd_app_sync", { name: "web" })).toMatchObject({
            status: "requested",
          });
          expect(await tools.callJson("argocd_app_sync", { name: "api" })).toEqual({
            ok: false,
            error: "out of scope: app:api is not in NIMBUS_MCP_ARGOCD_WRITE_SCOPE",
          });
          expect(prompts.map((p) => p.split("\n")[0])).toEqual([
            "Nimbus is about to perform argocd.app.sync with:",
          ]);
        },
      );
      expect(http.calls.map((c) => `${c.method} ${c.url}`)).toEqual([
        "POST https://argo.example.com/api/v1/applications/web/sync",
      ]);
    } finally {
      http.restore();
    }
  });
});
