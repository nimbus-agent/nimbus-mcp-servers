/**
 * The harness every connector's tools test stands on. Its own failure paths matter more than
 * most code's: a harness that swallowed a missing tool, a refused argument or an unexpected
 * request would turn the assertions built on it into tests that cannot fail.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import type { McpListResult } from "../shared/mcp-tool-kit.ts";
import {
  bootOverStubbedStdio,
  CapturedTools,
  type ConnectorRegistrar,
  captureStandaloneTools,
  captureTools,
  connectOverStubbedStdio,
  type FetchStub,
  refusalSaying,
  type SpawnStub,
  stubFetch,
  stubSpawn,
} from "./connector-tool-harness.ts";

const OK: McpListResult = { content: [{ type: "text", text: '{"ok":true}' }] };

/** A capture holding one tool, `t`, with the given schema and handler. */
function oneTool(
  schema: unknown,
  handler: (args: unknown) => Promise<McpListResult> = () => Promise.resolve(OK),
): CapturedTools {
  const tools = new CapturedTools();
  tools.add({ name: "t", description: "d", schema, handler });
  return tools;
}

describe("CapturedTools", () => {
  it("names a tool that was not registered, listing the ones that were", () => {
    const tools = oneTool(undefined);
    tools.add({
      name: "a_tool",
      description: "",
      schema: undefined,
      handler: () => Promise.resolve(OK),
    });
    expect(() => tools.get("t_typo")).toThrow('tool "t_typo" was not registered (have: a_tool, t)');
  });

  it("hands raw arguments to a tool registered without a schema", async () => {
    const seen: unknown[] = [];
    const tools = oneTool(undefined, (args) => {
      seen.push(args);
      return Promise.resolve(OK);
    });
    await tools.call("t", { raw: 1 });
    expect(seen).toEqual([{ raw: 1 }]);
  });

  it("refuses arguments the schema rejects, before the handler runs", async () => {
    let ran = 0;
    const tools = oneTool(z.object({ n: z.number() }), () => {
      ran += 1;
      return Promise.resolve(OK);
    });
    await expect(tools.call("t", { n: "one" })).rejects.toThrow(/"n"[\s\S]*expected number/);
    expect(ran).toBe(0);
  });

  it("names the tool when a refusing schema gives no message", async () => {
    const silent = { safeParse: () => ({ success: false }) };
    await expect(oneTool(silent).call("t", {})).rejects.toThrow('invalid arguments for "t"');
  });

  it("callJson refuses a result whose first block is not text", async () => {
    const image = oneTool(undefined, () =>
      Promise.resolve({ content: [{ type: "image", data: "", mimeType: "image/png" }] } as never),
    );
    await expect(image.callJson("t")).rejects.toThrow('tool "t" returned no text content');
    const empty = oneTool(undefined, () => Promise.resolve({ content: [] }));
    await expect(empty.callJson("t")).rejects.toThrow('tool "t" returned no text content');
  });
});

describe("refusalSaying", () => {
  const quoted = oneTool(
    z.object({ v: z.string().refine((s) => !s.startsWith("-"), 'must not start with "-"') }),
  );

  it("matches a refusal holding quotes, which a pattern written as read does not", async () => {
    // The refusal arrives as Zod's issues in JSON, so its quotes are escaped. Written as a person
    // reads it, the pattern never matches — which is the mistake this helper exists to prevent.
    await expect(quoted.call("t", { v: "-x" })).rejects.toThrow(
      refusalSaying('must not start with "-"'),
    );
    await expect(quoted.call("t", { v: "-x" })).rejects.not.toThrow(/must not start with "-"/);
  });

  it("matches the text literally, not as a pattern", () => {
    expect(refusalSaying("a.c").test("abc")).toBe(false);
    expect(refusalSaying("a.c").test("a.c")).toBe(true);
    expect(refusalSaying("(x)*").test("(x)*")).toBe(true);
  });

  it("does not match a different refusal", async () => {
    await expect(quoted.call("t", { v: "-x" })).rejects.not.toThrow(
      refusalSaying('must not start with "@"'),
    );
  });
});

describe("captureTools", () => {
  it("fails, rather than reporting an empty surface, when nothing registers", () => {
    expect(() => captureTools((() => undefined) as ConnectorRegistrar)).toThrow(
      "register…Tools registered no tools",
    );
  });

  it("rethrows the connector's own failure, not the probe's wrong-shape one", () => {
    // Called with the registrar first, then the server: both throw, and only the second is the
    // connector's own reason (a wrong guess about the argument fails inside the SDK instead).
    const register = ((first: unknown) => {
      if (typeof first === "function") {
        throw new Error("expected MCP server with .tool");
      }
      throw new Error("GRAFANA_URL is not set");
    }) as ConnectorRegistrar;
    expect(() => captureTools(register)).toThrow("GRAFANA_URL is not set");
  });

  it("rethrows the first failure when every failure is the probe's", () => {
    const register = (() => {
      throw new Error("expected MCP server with .tool (attempt)");
    }) as ConnectorRegistrar;
    expect(() => captureTools(register)).toThrow("expected MCP server with .tool (attempt)");
  });

  it("records a registerTool registration with no description or input schema", async () => {
    const tools = captureTools(((server: {
      registerTool: (n: string, c: object, h: () => Promise<McpListResult>) => unknown;
    }) => {
      server.registerTool("bare", {}, () => Promise.resolve(OK));
    }) as unknown as ConnectorRegistrar);
    expect(tools.get("bare").description).toBe("");
    expect(await tools.callJson("bare", {})).toEqual({ ok: true });
  });
});

describe("captureStandaloneTools", () => {
  it("reports no client capabilities until the handshake has run", () => {
    const seen: unknown[] = [];
    const { tools } = captureStandaloneTools(
      ((server: {
        server: { getClientCapabilities: () => unknown };
        tool: (n: string, d: string, s: object, h: () => Promise<McpListResult>) => unknown;
      }) => {
        seen.push(server.server.getClientCapabilities());
        server.tool("read", "r", {}, () => Promise.resolve(OK));
      }) as unknown as ConnectorRegistrar,
      { elicitation: true },
    );
    expect(tools.names()).toEqual(["read"]);
    // Before initialize the SDK knows nothing about the client; the stand-in agrees.
    expect(seen).toEqual([undefined]);
  });
});

describe("stubFetch", () => {
  let stub: FetchStub | undefined;
  afterEach(() => {
    stub?.restore();
    stub = undefined;
  });

  it("records a URL, a Request and a string alike, with every header form", async () => {
    stub = stubFetch("{}");
    await fetch(new URL("https://a.example/x"));
    // A header pair missing its value is not recorded as a header with no value.
    const pairs = [["X-A", "1"], ["X-Half"]] as unknown as [string, string][];
    await fetch(new Request("https://b.example/y"), { headers: pairs });
    await fetch("https://c.example/z", { headers: new Headers({ "X-B": "2" }), method: "PUT" });
    expect(stub.calls.map((c) => [c.method, c.url, c.headers])).toEqual([
      ["GET", "https://a.example/x", {}],
      ["GET", "https://b.example/y", { "x-a": "1" }],
      ["PUT", "https://c.example/z", { "x-b": "2" }],
    ]);
    // toEqual ignores an undefined-valued key, so the half pair's absence is asserted directly.
    expect(Object.keys(stub.calls[1]?.headers ?? {})).toEqual(["x-a"]);
  });

  it("fails loudly on a request its routing function did not expect", async () => {
    stub = stubFetch((req) => (req.url.endsWith("/known") ? "{}" : undefined));
    expect(await (await fetch("https://a.example/known")).text()).toBe("{}");
    await expect(fetch("https://a.example/other", { method: "POST" })).rejects.toThrow(
      "unexpected request: POST https://a.example/other",
    );
  });

  it("answers 200 with an empty object when a reply gives neither status nor body", async () => {
    stub = stubFetch({});
    const res = await fetch("https://a.example/");
    expect([res.status, await res.text()]).toEqual([200, "{}"]);
  });

  it("`only` insists on exactly one request", async () => {
    stub = stubFetch("{}");
    expect(() => stub?.only).toThrow("expected exactly 1 request, saw 0");
    await fetch("https://a.example/1");
    await fetch("https://a.example/2");
    expect(() => stub?.only).toThrow("expected exactly 1 request, saw 2");
  });
});

describe("stubSpawn", () => {
  let stub: SpawnStub | undefined;
  afterEach(() => {
    stub?.restore();
    stub = undefined;
  });

  it("records an invocation made without options as having an empty env", () => {
    stub = stubSpawn();
    Bun.spawn(["tool", "--flag"]);
    expect(stub.calls).toEqual([{ command: ["tool", "--flag"], env: {} }]);
  });

  it("runs onSpawn with the command at the moment of the spawn", () => {
    const seen: string[][] = [];
    stub = stubSpawn({ onSpawn: (command) => seen.push([...command]) });
    expect(seen).toEqual([]);
    Bun.spawn(["tool", "--flag"]);
    expect(seen).toEqual([["tool", "--flag"]]);
  });
});

describe("bootOverStubbedStdio and connectOverStubbedStdio", () => {
  /** A bootstrap shaped like a connector's: build a server, register, connect a stdio transport. */
  function probeServer(): { server: McpServer; boot: () => Promise<void> } {
    const server = new McpServer({ name: "nimbus-probe", version: "1.2.3" });
    server.registerTool("probe_ping", { description: "answers pong" }, () =>
      Promise.resolve({ content: [{ type: "text" as const, text: "pong" }] }),
    );
    return { server, boot: () => server.connect(new StdioServerTransport()) };
  }

  it("hands the bootstrap's transport in-memory ends, then puts the real streams back", async () => {
    const real = { stdin: process.stdin, stdout: process.stdout };
    const seen: unknown[] = [];
    const { server, boot } = probeServer();
    const stdio = await bootOverStubbedStdio(async () => {
      seen.push(process.stdin, process.stdout);
      await boot();
    });
    expect(seen).toEqual([stdio.toServer, stdio.fromServer]);
    expect(process.stdin).toBe(real.stdin);
    expect(process.stdout).toBe(real.stdout);

    // The server took the stubs, not the real streams: a whole round trip happens over them.
    const client = await connectOverStubbedStdio(stdio);
    try {
      // With no capabilities given, the client advertises none — so no elicitation.
      expect(server.server.getClientCapabilities()?.elicitation).toBeUndefined();
      expect(client.getServerVersion()).toEqual({ name: "nimbus-probe", version: "1.2.3" });
      expect((await client.listTools()).tools.map((t) => t.name)).toEqual(["probe_ping"]);
      expect(await client.callTool({ name: "probe_ping" })).toEqual({
        content: [{ type: "text", text: "pong" }],
      });
    } finally {
      await client.close();
    }
  });

  it("puts the real streams back when the bootstrap throws", async () => {
    const real = { stdin: process.stdin, stdout: process.stdout };
    let during: unknown;
    await expect(
      bootOverStubbedStdio(() => {
        during = process.stdout;
        return Promise.reject(new Error("bootstrap needs a variable"));
      }),
    ).rejects.toThrow("bootstrap needs a variable");
    expect(during).not.toBe(real.stdout);
    expect(process.stdin).toBe(real.stdin);
    expect(process.stdout).toBe(real.stdout);
  });

  it("advertises the capabilities it is given, and stops reading once closed", async () => {
    const { server, boot } = probeServer();
    const stdio = await bootOverStubbedStdio(boot);
    const client = await connectOverStubbedStdio(stdio, { elicitation: {} });
    // The SDK fills in the elicitation modes it defaults to, so only presence is pinned here.
    expect(server.server.getClientCapabilities()?.elicitation).toBeDefined();
    expect(stdio.fromServer.listenerCount("data")).toBe(1);
    await client.close();
    expect(stdio.fromServer.listenerCount("data")).toBe(0);
  });
});
