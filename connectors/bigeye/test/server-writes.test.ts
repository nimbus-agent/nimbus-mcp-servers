import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { resetConnectorModeForTests, setConnectorMode } from "../../../shared/connector-mode.ts";
import type { McpListResult, ZodObjectSchema } from "../../../shared/mcp-tool-kit.ts";
import { registerBigeyeTools } from "../src/server.ts";

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
  registerBigeyeTools(
    <T>(
      name: string,
      _desc: string,
      _schema: ZodObjectSchema<T>,
      handler: (args: T) => Promise<McpListResult>,
    ) => {
      tools.set(name, handler as Handler);
    },
    consentFakeServer((n, h) => tools.set(n, h as Handler)),
  );
  return tools;
}

function payload(res: McpListResult): Record<string, unknown> {
  return JSON.parse((res.content[0] as { text: string }).text) as Record<string, unknown>;
}

describe("bigeye write tools", () => {
  const origFetch = globalThis.fetch;
  let calls: Array<{ url: string; method: string; headers: Record<string, string>; body: string }> =
    [];

  beforeEach(() => {
    calls = [];
    process.env["BIGEYE_BASE_URL"] = "https://bigeye.example.com";
    process.env["BIGEYE_API_KEY"] = "test-api-key";
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      calls.push({
        url: String(url),
        method: String(init?.method ?? "GET"),
        headers: (init?.headers as Record<string, string>) ?? {},
        body: typeof init?.body === "string" ? init.body : "",
      });
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = origFetch;
    delete process.env["BIGEYE_BASE_URL"];
    delete process.env["BIGEYE_API_KEY"];
  });

  it("bigeye_issue_acknowledge POSTs to /api/v1/issues with ACKNOWLEDGED status and Bearer auth", async () => {
    const out = payload(
      await (captureTools().get("bigeye_issue_acknowledge") as Handler)({ issueId: "i1" }),
    );

    expect(out).toEqual({ status: "ok", issueId: "i1" });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url).toBe("https://bigeye.example.com/api/v1/issues");
    expect(calls[0]?.headers["Authorization"]).toBe("Bearer test-api-key");
    expect(JSON.parse(calls[0]?.body ?? "{}")).toEqual({
      issueId: "i1",
      status: "ISSUE_STATUS_ACKNOWLEDGED",
    });
  });

  it("bigeye_issue_resolve POSTs to /api/v1/issues with CLOSED status", async () => {
    const out = payload(
      await (captureTools().get("bigeye_issue_resolve") as Handler)({ issueId: "i2" }),
    );

    expect(out).toEqual({ status: "ok", issueId: "i2" });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url).toBe("https://bigeye.example.com/api/v1/issues");
    expect(JSON.parse(calls[0]?.body ?? "{}")).toEqual({
      issueId: "i2",
      status: "ISSUE_STATUS_CLOSED",
    });
  });

  it("propagates non-ok response as a thrown error", async () => {
    globalThis.fetch = (async () => {
      return new Response("Unauthorized", { status: 401 });
    }) as unknown as typeof fetch;

    await expect(
      (captureTools().get("bigeye_issue_acknowledge") as Handler)({ issueId: "bad" }),
    ).rejects.toThrow("401");
  });
});

describe("bigeye write tools in STANDALONE mode", () => {
  // Both write tools come from one registration helper. What tells them apart is the action type
  // each asks the human to approve and the status it sends, and gateway mode never shows the
  // first, so this pins it — and the issue scope both declare — on the guarded path.
  const origFetch = globalThis.fetch;
  let statusSent: unknown[] = [];

  beforeEach(() => {
    // The file-level hook has just set gateway mode, and the setter refuses a conflicting change.
    resetConnectorModeForTests();
    setConnectorMode("standalone");
    process.env["NIMBUS_MCP_BIGEYE_WRITE_SCOPE"] = "issue:i1";
    process.env["BIGEYE_BASE_URL"] = "https://bigeye.example.com";
    process.env["BIGEYE_API_KEY"] = "test-api-key";
    statusSent = [];
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      statusSent.push((JSON.parse(String(init?.body)) as Record<string, unknown>)["status"]);
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = origFetch;
    delete process.env["NIMBUS_MCP_BIGEYE_WRITE_SCOPE"];
    delete process.env["BIGEYE_BASE_URL"];
    delete process.env["BIGEYE_API_KEY"];
  });

  /** A client that can prompt, and approves every prompt, recording the first line of each. */
  function approvingStandaloneTools(prompts: string[]): Map<string, Handler> {
    const tools = new Map<string, Handler>();
    let ready = false;
    const srv = {
      server: {
        getClientCapabilities: () => (ready ? { elicitation: {} } : undefined),
        oninitialized: undefined as (() => void) | undefined,
        elicitInput: (req: { message: string }) => {
          prompts.push(req.message.split("\n")[0] ?? "");
          return Promise.resolve({ action: "accept", content: { confirm: true } });
        },
      },
      registerTool: (name: string, _cfg: unknown, handler: Handler) => {
        tools.set(name, handler);
        return { disable: () => undefined };
      },
      sendToolListChanged: () => undefined,
      sendLoggingMessage: () => Promise.resolve(),
    };
    registerBigeyeTools(() => undefined, srv);
    ready = true;
    srv.server.oninitialized?.();
    return tools;
  }

  function tool(tools: Map<string, Handler>, name: string): Handler {
    const handler = tools.get(name);
    if (handler === undefined) throw new Error(`tool not registered: ${name}`);
    return handler;
  }

  it("each tool asks approval for its own action type and sends its own status", async () => {
    const prompts: string[] = [];
    const tools = approvingStandaloneTools(prompts);
    await tool(tools, "bigeye_issue_acknowledge")({ issueId: "i1" });
    await tool(tools, "bigeye_issue_resolve")({ issueId: "i1" });
    expect(prompts).toEqual([
      "Nimbus is about to perform bigeye.issue.acknowledge with:",
      "Nimbus is about to perform bigeye.issue.resolve with:",
    ]);
    expect(statusSent).toEqual(["ISSUE_STATUS_ACKNOWLEDGED", "ISSUE_STATUS_CLOSED"]);
  });

  it("an issue outside the write scope is refused before any prompt or request", async () => {
    const prompts: string[] = [];
    const tools = approvingStandaloneTools(prompts);
    const out = payload(await tool(tools, "bigeye_issue_resolve")({ issueId: "i9" }));
    expect(out).toEqual({
      ok: false,
      error: "out of scope: issue:i9 is not in NIMBUS_MCP_BIGEYE_WRITE_SCOPE",
    });
    expect(prompts).toEqual([]);
    expect(statusSent).toEqual([]);
  });
});
