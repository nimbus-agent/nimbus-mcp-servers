import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import { McpStateError } from "@nimbus-dev/sdk/mcp-server";
import { z } from "zod";

import { resetConnectorModeForTests, setConnectorMode } from "./connector-mode.ts";
import { createConnectorServer } from "./connector-server.ts";
import { createLayerServer, type LayerServer } from "./layer-server.ts";

const MODERN = "2026-07-28";
const META = (capabilities: Record<string, unknown> = {}) => ({
  _meta: {
    "io.modelcontextprotocol/protocolVersion": MODERN,
    "io.modelcontextprotocol/clientCapabilities": capabilities,
  },
});

type Reply = {
  id?: unknown;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
};

/** One request to a layer server on a fresh 2026-07-28 connection, and its answer. */
async function ask(
  server: LayerServer,
  method: string,
  params: Record<string, unknown> = {},
  capabilities: Record<string, unknown> = {},
): Promise<Reply> {
  const sent: Reply[] = [];
  const connection = server.layer.connect((m) => sent.push(m as unknown as Reply));
  await connection.receive({
    jsonrpc: "2.0",
    id: 1,
    method,
    params: { ...params, ...META(capabilities) },
  });
  return sent[0] ?? {};
}

const text = (reply: Reply): string =>
  ((reply.result?.["content"] as Array<{ text?: string }> | undefined) ?? [])
    .map((c) => c.text ?? "")
    .join("");

const OK = { content: [{ type: "text" as const, text: "ok" }] };

describe("createLayerServer", () => {
  test("lists a tool with the JSON Schema of its zod shape, draft-07, as the upstream server did", async () => {
    const server = createLayerServer({ name: "nimbus-t", version: "0.1.0" });
    server.registerTool(
      "acme_get",
      {
        description: "Get one",
        inputSchema: { id: z.string(), limit: z.number().int().positive().optional() },
        annotations: { readOnlyHint: true },
      },
      () => OK,
    );
    const listed = await ask(server, "tools/list");
    expect(listed.result?.["tools"]).toEqual([
      {
        name: "acme_get",
        description: "Get one",
        inputSchema: {
          $schema: "http://json-schema.org/draft-07/schema#",
          type: "object",
          properties: {
            id: { type: "string" },
            limit: { type: "integer", exclusiveMinimum: 0, maximum: 9007199254740991 },
          },
          required: ["id"],
        },
        annotations: { readOnlyHint: true },
      },
    ]);
    // A modern client may not cache the list: a write tool leaves it when the budget is spent.
    expect(listed.result?.["ttlMs"]).toBe(0);
  });

  test("the four-argument form registers the same way, and a tool with no shape takes any object", async () => {
    const server = createLayerServer({ name: "nimbus-t", version: "0.1.0" });
    server.tool("acme_list", "List", { q: z.string() }, () => OK);
    server.registerTool("acme_ping", {}, () => OK);
    const tools = (await ask(server, "tools/list")).result?.["tools"] as Array<
      Record<string, unknown>
    >;
    expect(tools.map((t) => [t["name"], t["description"]])).toEqual([
      ["acme_list", "List"],
      ["acme_ping", ""],
    ]);
    expect(tools[1]?.["inputSchema"]).toEqual({ type: "object" });
    expect(
      text(await ask(server, "tools/call", { name: "acme_ping", arguments: { any: 1 } })),
    ).toBe("ok");
  });

  test("arguments are checked against the shape before the callback, which gets only what it names", async () => {
    const seen: unknown[] = [];
    const server = createLayerServer({ name: "nimbus-t", version: "0.1.0" });
    server.registerTool("acme_get", { inputSchema: { id: z.string() } }, (args) => {
      seen.push(args);
      return OK;
    });
    const bad = await ask(server, "tools/call", { name: "acme_get", arguments: { id: 7 } });
    expect(bad.result?.["isError"]).toBe(true);
    expect(text(bad)).toStartWith("Invalid arguments for tool acme_get: ");
    expect(seen).toEqual([]);
    await ask(server, "tools/call", { name: "acme_get", arguments: { id: "a", extra: "dropped" } });
    expect(seen).toEqual([{ id: "a" }]);
  });

  test("whatever a tool throws reaches the client with its own message; a state error stays a protocol error", async () => {
    const server = createLayerServer({ name: "nimbus-t", version: "0.1.0" });
    server.registerTool("throws_error", {}, () => {
      throw new Error("GitHub API 404");
    });
    server.registerTool("throws_text", {}, () => Promise.reject("remote said no"));
    server.registerTool("bad_state", {}, () => {
      throw new McpStateError("expired");
    });
    const failed = await ask(server, "tools/call", { name: "throws_error" });
    expect(failed.result?.["isError"]).toBe(true);
    expect(text(failed)).toBe("GitHub API 404");
    expect(text(await ask(server, "tools/call", { name: "throws_text" }))).toBe("remote said no");
    const state = await ask(server, "tools/call", { name: "bad_state" });
    expect(state.error?.code).toBe(-32602);
    expect(state.result).toBeUndefined();
  });

  test("listing follows `listed` and `disable()`; calling follows neither", async () => {
    const server = createLayerServer({ name: "nimbus-t", version: "0.1.0" });
    server.registerTool("read", {}, () => OK);
    const write = server.registerTool(
      "write",
      { listed: (client) => "elicitation" in client.clientCapabilities },
      () => OK,
    );
    const names = async (caps: Record<string, unknown>) =>
      (
        ((await ask(server, "tools/list", {}, caps)).result?.["tools"] ?? []) as Array<{
          name: string;
        }>
      ).map((t) => t.name);
    expect(await names({})).toEqual(["read"]);
    expect(await names({ elicitation: {} })).toEqual(["read", "write"]);
    // Not listed to this client, and it answers all the same.
    expect(text(await ask(server, "tools/call", { name: "write" }))).toBe("ok");
    write.disable();
    expect(await names({ elicitation: {} })).toEqual(["read"]);
    expect(text(await ask(server, "tools/call", { name: "write" }, { elicitation: {} }))).toBe(
      "ok",
    );
    expect(server.toolsFor("call", { clientCapabilities: {} }).map((t) => t.name)).toEqual([
      "read",
      "write",
    ]);
    // A name nobody registered is the layer's unknown tool.
    expect((await ask(server, "tools/call", { name: "nope" })).error?.code).toBe(-32602);
  });

  test("a second tool of one name is refused at registration, and instructions reach the client", async () => {
    const server = createLayerServer(
      { name: "nimbus-t", version: "0.1.0" },
      { instructions: "Read the NOTICE." },
    );
    server.registerTool("acme_get", {}, () => OK);
    expect(() => server.registerTool("acme_get", {}, () => OK)).toThrow("already registered");
    expect((await ask(server, "server/discover")).result?.["instructions"]).toBe(
      "Read the NOTICE.",
    );
    const plain = createLayerServer({ name: "nimbus-t", version: "0.1.0" });
    expect((await ask(plain, "server/discover")).result?.["instructions"]).toBeUndefined();
  });
});

describe("connect: serving on the process's stdio", () => {
  type Swapped = { stdin: PassThrough; stdout: PassThrough };

  /** Runs `fn` with the process's stdin and stdout replaced by in-memory streams. */
  async function withStdio(fn: () => Promise<void>): Promise<Swapped> {
    const io: Swapped = { stdin: new PassThrough(), stdout: new PassThrough() };
    const proc = process as unknown as { stdin: unknown; stdout: unknown };
    const real = { stdin: proc.stdin, stdout: proc.stdout };
    proc.stdin = io.stdin;
    proc.stdout = io.stdout;
    try {
      await fn();
    } finally {
      proc.stdin = real.stdin;
      proc.stdout = real.stdout;
    }
    return io;
  }

  function nextLine(stream: PassThrough): Promise<string> {
    return new Promise((resolve) => {
      let buffered = "";
      const onData = (chunk: Buffer): void => {
        buffered += chunk.toString("utf8");
        const at = buffered.indexOf("\n");
        if (at !== -1) {
          stream.off("data", onData);
          resolve(buffered.slice(0, at));
        }
      };
      stream.on("data", onData);
    });
  }

  test("it serves on the streams the process had when it started, one message per line", async () => {
    const server = createLayerServer({ name: "nimbus-t", version: "0.1.0" });
    server.registerTool("acme_ping", {}, () => OK);
    const io = await withStdio(() => server.connect());
    // Resolved once serving, and silent until the client speaks: stdout is the protocol channel.
    expect(io.stdout.readableLength).toBe(0);
    const answer = nextLine(io.stdout);
    io.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: META() })}\n`,
    );
    const reply = JSON.parse(await answer) as Reply;
    expect(((reply.result?.["tools"] ?? []) as Array<{ name: string }>).map((t) => t.name)).toEqual(
      ["acme_ping"],
    );
    io.stdin.end();
  });

  test("a failing output stream is reported on stderr and sets a failing exit code", async () => {
    const server = createLayerServer({ name: "nimbus-broken", version: "0.1.0" });
    const written: string[] = [];
    const realWrite = process.stderr.write.bind(process.stderr);
    const realExit = process.exitCode;
    process.stderr.write = (chunk: string | Uint8Array): boolean => {
      written.push(String(chunk));
      return true;
    };
    try {
      const io = await withStdio(() => server.connect());
      io.stdout.write = (): boolean => {
        throw new Error("EPIPE");
      };
      io.stdin.write(
        `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: META() })}\n`,
      );
      for (let i = 0; i < 100 && written.length === 0; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 2));
      }
      expect(written.join("")).toContain(
        "nimbus-connector nimbus-broken: the MCP connection failed: EPIPE",
      );
      expect(process.exitCode).toBe(1);
    } finally {
      process.stderr.write = realWrite;
      process.exitCode = realExit ?? 0;
    }
  });
});

describe("createConnectorServer", () => {
  beforeEach(resetConnectorModeForTests);
  afterEach(resetConnectorModeForTests);

  test("standalone, the default: the layer server, with the instructions it was given", async () => {
    const built = createConnectorServer(
      { name: "nimbus-t", version: "0.1.0" },
      { instructions: "Read the NOTICE." },
    );
    expect("layer" in built.server).toBe(true);
    const discovered = await ask(built.server as LayerServer, "server/discover");
    expect(discovered.result?.["instructions"]).toBe("Read the NOTICE.");
    expect(typeof built.start).toBe("function");
  });

  test("gateway: the upstream server, declaring logging, with the same instructions", () => {
    setConnectorMode("gateway");
    const built = createConnectorServer(
      { name: "nimbus-t", version: "0.1.0" },
      { instructions: "Read the NOTICE." },
    );
    expect("layer" in built.server).toBe(false);
    const upstream = built.server as unknown as {
      server: { _capabilities?: unknown; _instructions?: unknown };
      connect: unknown;
    };
    expect(typeof upstream.connect).toBe("function");
    expect(upstream.server._capabilities).toMatchObject({ logging: {} });
    expect(upstream.server._instructions).toBe("Read the NOTICE.");
    // And with none given, none is sent.
    const plain = createConnectorServer({ name: "nimbus-t", version: "0.1.0" });
    expect(
      (plain.server as unknown as { server: { _instructions?: unknown } }).server._instructions,
    ).toBeUndefined();
  });
});
