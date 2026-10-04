import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { resetConnectorModeForTests, setConnectorMode } from "../../../shared/connector-mode.ts";
import type { McpListResult, ZodObjectSchema } from "../../../shared/mcp-tool-kit.ts";
import { registerMonteCarloTools } from "../src/server.ts";

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
  registerMonteCarloTools(
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

function tool(tools: Map<string, Handler>, name: string): Handler {
  const handler = tools.get(name);
  if (handler === undefined) throw new Error(`tool not registered: ${name}`);
  return handler;
}

function payload(res: McpListResult): Record<string, unknown> {
  return JSON.parse((res.content[0] as { text: string }).text) as Record<string, unknown>;
}

interface Captured {
  url: string;
  method: string;
  query: string;
  variables: Record<string, unknown>;
}

describe("monte carlo write tools", () => {
  const origFetch = globalThis.fetch;
  let calls: Captured[] = [];

  beforeEach(() => {
    calls = [];
    process.env["MONTECARLO_API_ID"] = "id";
    process.env["MONTECARLO_API_TOKEN"] = "token";
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        query: string;
        variables: Record<string, unknown>;
      };
      calls.push({
        url: String(url),
        method: String(init?.method),
        query: body.query,
        variables: body.variables,
      });
      return new Response(
        JSON.stringify({ data: { setIncidentFeedback: { __typename: "SetIncidentFeedback" } } }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = origFetch;
    delete process.env["MONTECARLO_API_ID"];
    delete process.env["MONTECARLO_API_TOKEN"];
  });

  it("acknowledge POSTs setIncidentFeedback with ACKNOWLEDGED feedback", async () => {
    const out = payload(
      await tool(captureTools(), "montecarlo_incident_acknowledge")({ incidentId: "i1" }),
    );
    expect(out).toEqual({ status: "ok", incidentId: "i1" });
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url).toContain("api.getmontecarlo.com/graphql");
    expect(calls[0]?.query).toContain("setIncidentFeedback");
    expect(calls[0]?.variables).toEqual({ incidentId: "i1", feedback: "ACKNOWLEDGED" });
  });

  it("resolve POSTs setIncidentFeedback with RESOLVED feedback", async () => {
    const out = payload(
      await tool(captureTools(), "montecarlo_incident_resolve")({ incidentId: "i2" }),
    );
    expect(out).toEqual({ status: "ok", incidentId: "i2" });
    expect(calls[0]?.variables).toEqual({ incidentId: "i2", feedback: "RESOLVED" });
  });

  it("throws on a GraphQL errors response", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ errors: [{ message: "incident not found" }] }), {
        status: 200,
      })) as unknown as typeof fetch;

    await expect(
      tool(captureTools(), "montecarlo_incident_acknowledge")({ incidentId: "bad" }),
    ).rejects.toThrow("incident not found");
  });

  it("throws on a non-ok HTTP response", async () => {
    globalThis.fetch = (async () =>
      new Response("Forbidden", { status: 403 })) as unknown as typeof fetch;

    await expect(
      tool(captureTools(), "montecarlo_incident_resolve")({ incidentId: "i3" }),
    ).rejects.toThrow("403");
  });
});

describe("monte carlo write tools in STANDALONE mode", () => {
  // Both write tools come from one registration helper. What tells them apart is the action type
  // each asks the human to approve and the feedback value it sends, and gateway mode never shows
  // the first, so this pins it — and the incident scope both declare — on the guarded path.
  const origFetch = globalThis.fetch;
  let feedbackSent: unknown[] = [];

  beforeEach(() => {
    // The file-level hook has just set gateway mode, and the setter refuses a conflicting change.
    resetConnectorModeForTests();
    setConnectorMode("standalone");
    process.env["NIMBUS_MCP_MONTE_CARLO_WRITE_SCOPE"] = "incident:i1";
    process.env["MONTECARLO_API_ID"] = "id";
    process.env["MONTECARLO_API_TOKEN"] = "token";
    feedbackSent = [];
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { variables: Record<string, unknown> };
      feedbackSent.push(body.variables["feedback"]);
      return new Response(JSON.stringify({ data: { setIncidentFeedback: {} } }), { status: 200 });
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = origFetch;
    delete process.env["NIMBUS_MCP_MONTE_CARLO_WRITE_SCOPE"];
    delete process.env["MONTECARLO_API_ID"];
    delete process.env["MONTECARLO_API_TOKEN"];
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
    registerMonteCarloTools(() => undefined, srv);
    ready = true;
    srv.server.oninitialized?.();
    return tools;
  }

  it("each tool asks approval for its own action type and sends its own feedback", async () => {
    const prompts: string[] = [];
    const tools = approvingStandaloneTools(prompts);
    await tool(tools, "montecarlo_incident_acknowledge")({ incidentId: "i1" });
    await tool(tools, "montecarlo_incident_resolve")({ incidentId: "i1" });
    expect(prompts).toEqual([
      "Nimbus is about to perform montecarlo.incident.acknowledge with:",
      "Nimbus is about to perform montecarlo.incident.resolve with:",
    ]);
    expect(feedbackSent).toEqual(["ACKNOWLEDGED", "RESOLVED"]);
  });

  it("an incident outside the write scope is refused before any prompt or request", async () => {
    const prompts: string[] = [];
    const tools = approvingStandaloneTools(prompts);
    const out = payload(await tool(tools, "montecarlo_incident_resolve")({ incidentId: "i9" }));
    expect(out).toEqual({
      ok: false,
      error: "out of scope: incident:i9 is not in NIMBUS_MCP_MONTE_CARLO_WRITE_SCOPE",
    });
    expect(prompts).toEqual([]);
    expect(feedbackSent).toEqual([]);
  });
});
