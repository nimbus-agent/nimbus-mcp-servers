import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { approvedStandaloneWrite } from "../../../scripts/connector-tool-harness.ts";
import { resetConnectorModeForTests, setConnectorMode } from "../../../shared/connector-mode.ts";
import { registerArgocdTools } from "../src/server.ts";

describe("argocd writes are not recoverable (standalone mode)", () => {
  const origFetch = globalThis.fetch;
  let calls: { method: string; url: string }[] = [];
  let getReply: () => Response;

  beforeEach(() => {
    resetConnectorModeForTests();
    setConnectorMode("standalone");
    calls = [];
    getReply = () =>
      new Response(
        JSON.stringify({
          status: { sync: { revision: "abc123", status: "Synced" }, health: { status: "Healthy" } },
        }),
        { status: 200 },
      );
    process.env["ARGOCD_URL"] = "https://argo.example.com";
    process.env["ARGOCD_TOKEN"] = "tok";
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      const method = String(init?.method ?? "GET");
      calls.push({ method, url: String(url) });
      return method === "GET" ? getReply() : new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = origFetch;
    delete process.env["ARGOCD_URL"];
    delete process.env["ARGOCD_TOKEN"];
    resetConnectorModeForTests();
  });

  const base = "https://argo.example.com/api/v1/applications/web";
  const tools = [
    { tool: "argocd_app_sync", args: { name: "web" }, path: "/sync" },
    { tool: "argocd_app_rollback", args: { name: "web", id: 3 }, path: "/rollback" },
  ];

  for (const t of tools) {
    const run = (): ReturnType<typeof approvedStandaloneWrite> =>
      approvedStandaloneWrite(
        registerArgocdTools,
        { NIMBUS_MCP_ARGOCD_WRITE_SCOPE: "app:web" },
        t.tool,
        t.args,
      );

    it(`${t.tool} reads the application first and audits its revision, sync and health`, async () => {
      const done = await run();
      expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
        `GET ${base}`,
        `POST ${base}${t.path}`,
      ]);
      expect(done.audit.find((e) => e.outcome === "executed")?.detail["preState"]).toEqual({
        app: "web",
        revision: "abc123",
        syncStatus: "Synced",
        health: "Healthy",
      });
      expect(done.chain.ok).toBe(true);
    });

    it(`${t.tool} records null for fields the application lacks`, async () => {
      getReply = () => new Response("{}", { status: 200 });
      const done = await run();
      expect(done.audit.find((e) => e.outcome === "executed")?.detail["preState"]).toEqual({
        app: "web",
        revision: null,
        syncStatus: null,
        health: null,
      });
    });

    it(`${t.tool} records captureFailed when the read fails, and still runs`, async () => {
      getReply = () => new Response("no such app", { status: 404 });
      const done = await run();
      expect(calls.map((c) => c.method)).toEqual(["GET", "POST"]);
      expect(done.audit.find((e) => e.outcome === "executed")?.detail["preState"]).toEqual({
        captureFailed: expect.stringContaining("ArgoCD 404"),
      });
    });
  }
});
