/**
 * The standalone connector server: the surface connectors already use (`registerTool`, a handle
 * with `disable()`, `connect()`), built on `@nimbus-dev/sdk/mcp-server` instead of the upstream MCP
 * SDK. One process then answers a client of MCP revision 2026-07-28 and a client that opens with
 * `initialize`.
 *
 * Only `shared/connector-server.ts` builds one, and only in standalone mode. A connector the
 * Nimbus gateway spawned keeps the upstream server.
 */
import {
  createMcpServer,
  type McpInputRequired,
  type McpJsonObject,
  type McpServer,
  McpStateError,
  type McpTool,
  type McpToolContext,
  McpToolError,
  type McpToolResult,
  serveStdio,
} from "@nimbus-dev/sdk/mcp-server";
import { z } from "zod";
import { scrubErrorText } from "./error-text.ts";

/** What a tool callback may return: a result, or (the consent kit only) a request for input. */
export type LayerToolReturn = McpToolResult | McpInputRequired;

export type LayerToolCallback = (
  args: unknown,
  ctx: McpToolContext,
) => Promise<LayerToolReturn> | LayerToolReturn;

export interface LayerToolConfig {
  readonly description?: string;
  /** A zod raw shape, as connectors pass to the upstream `registerTool`. */
  readonly inputSchema?: unknown;
  readonly annotations?: McpJsonObject;
  /**
   * Whether `tools/list` shows this tool to the client behind a request. Default: always. It
   * decides LISTING only: a tool is callable whether or not it is listed, so its handler still
   * answers, and records, a call that names it.
   */
  readonly listed?: (client: { readonly clientCapabilities: McpJsonObject }) => boolean;
}

/** `disable()` takes the tool out of `tools/list`. It stays callable (see `listed`). */
export interface LayerToolHandle {
  disable(): void;
}

export interface LayerServer {
  registerTool(name: string, config: LayerToolConfig, cb: LayerToolCallback): LayerToolHandle;
  /**
   * The upstream server's older four-argument form, which `createRegisterSimpleTool` of the SDK's
   * connector kit binds to: every read tool is registered through it.
   */
  tool(
    name: string,
    description: string,
    inputShape: Record<string, unknown>,
    handler: LayerToolCallback,
  ): LayerToolHandle;
  /**
   * Starts serving on this process's stdio and resolves once it is serving, as the upstream
   * `connect` does. The process then lives for as long as its stdin does.
   */
  connect(): Promise<void>;
  /** The underlying layer server, for a test that drives a connection without stdio. */
  readonly layer: McpServer;
  /**
   * The tools a request is answered with: for `list`, those not disabled whose `listed` says yes
   * for that client; for `call`, every registered tool. It IS the rule the layer is given.
   */
  toolsFor(
    purpose: "list" | "call",
    client: { readonly clientCapabilities: McpJsonObject },
  ): McpTool[];
}

export interface LayerServerOptions {
  readonly instructions?: string;
}

type Registered = {
  readonly tool: McpTool;
  readonly listed: NonNullable<LayerToolConfig["listed"]>;
  disabled: boolean;
};

function isShape(value: unknown): value is Record<string, z.core.$ZodType> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The message of whatever was thrown, which need not be an `Error`. */
function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function createLayerServer(
  info: { readonly name: string; readonly version: string },
  options: LayerServerOptions = {},
): LayerServer {
  const tools = new Map<string, Registered>();

  const toolsFor: LayerServer["toolsFor"] = (purpose, client) => {
    const out: McpTool[] = [];
    for (const entry of tools.values()) {
      // Every registered tool can be CALLED. Listing is the only thing a tool's `listed`
      // predicate and its handle's `disable()` decide.
      if (purpose === "call" || (!entry.disabled && entry.listed(client))) out.push(entry.tool);
    }
    return out;
  };

  const layer = createMcpServer({
    name: info.name,
    version: info.version,
    ...(options.instructions === undefined ? {} : { instructions: options.instructions }),
    tools: (ctx) => toolsFor(ctx.purpose, ctx),
  });

  function registerTool(
    name: string,
    config: LayerToolConfig,
    cb: LayerToolCallback,
  ): LayerToolHandle {
    if (tools.has(name)) throw new Error(`Tool ${name} is already registered`);
    const shape = isShape(config.inputSchema) ? z.object(config.inputSchema) : undefined;
    const inputSchema: McpJsonObject =
      shape === undefined
        ? { type: "object" }
        : // draft-07 with the input side of each schema: what the upstream SDK listed.
          (z.toJSONSchema(shape, { target: "draft-7", io: "input" }) as McpJsonObject);
    const definition: McpTool = {
      name,
      description: config.description ?? "",
      inputSchema,
      ...(config.annotations === undefined ? {} : { annotations: config.annotations }),
      handler: async (args, ctx) => {
        let parsed: unknown = args;
        if (shape !== undefined) {
          // The layer sends a schema and enforces nothing, so the arguments are checked here, as
          // the upstream server checked them, and only the members the shape names go on.
          const result = shape.safeParse(args);
          if (!result.success) {
            throw new McpToolError(`Invalid arguments for tool ${name}: ${result.error.message}`);
          }
          parsed = result.data;
        }
        try {
          return await cb(parsed, ctx);
        } catch (e) {
          // A request state that failed verification is a protocol error; the layer answers it.
          if (e instanceof McpStateError) throw e;
          // Everything else reaches the client with its own message, as it did on the upstream
          // server: a connector's thrown text is its diagnostic ("GitHub API 404"), and for a
          // write it can be the only word that the write RAN ("ran, but recording that it ran
          // failed"). The layer's default, `Tool failed`, would hide exactly that. What it does
          // not keep is a credential or a local path the text picked up from an upstream reply,
          // a CLI's stderr or a library's error: `scrubErrorText` replaces those.
          throw new McpToolError(scrubErrorText(messageOf(e)));
        }
      },
    };
    const entry: Registered = {
      tool: definition,
      listed: config.listed ?? ((): boolean => true),
      disabled: false,
    };
    tools.set(name, entry);
    return {
      disable: (): void => {
        entry.disabled = true;
      },
    };
  }

  function connect(): Promise<void> {
    // Read once, here: what this process's stdio is when the server starts is what it serves on.
    const input = process.stdin;
    const output = process.stdout;
    void serveStdio(layer, {
      input,
      write: (line) => {
        output.write(line);
      },
    }).catch((e: unknown) => {
      // stderr is safe: the protocol channel is stdout.
      process.stderr.write(
        `nimbus-connector ${info.name}: the MCP connection failed: ${messageOf(e)}\n`,
      );
      process.exitCode = 1;
    });
    return Promise.resolve();
  }

  const tool: LayerServer["tool"] = (name, description, inputShape, handler) =>
    registerTool(name, { description, inputSchema: inputShape }, handler);

  return { registerTool, tool, connect, layer, toolsFor };
}
