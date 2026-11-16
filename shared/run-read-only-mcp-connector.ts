import { createConnectorServer } from "./connector-server.ts";
import {
  createRegisterSimpleTool,
  createZodToolRegistrar,
  type McpListResult,
  type ZodObjectSchema,
} from "./mcp-tool-kit.ts";

export type ZodToolRegistrar = <T>(
  name: string,
  description: string,
  schema: ZodObjectSchema<T>,
  handler: (args: T) => Promise<McpListResult>,
) => void;

/** A server and the function that starts it, as `createConnectorServer` returns them. */
export interface BuiltConnector {
  readonly server: unknown;
  start(): Promise<void>;
}

/**
 * `createConnector` is the test seam. Without it `runReadOnlyMcpConnector` — the function every
 * connector's entry point actually calls — could not be executed from a test at all: it would
 * start serving on the test process's stdio. That left the wiring between the server and its start
 * asserted nowhere.
 *
 * Production callers pass nothing and get `createConnectorServer` (`shared/connector-server.ts`),
 * the one place a connector's server is built.
 */
export interface BuildReadOnlyMcpConnectorOptions {
  readonly createConnector?: (info: {
    readonly name: string;
    readonly version: string;
  }) => BuiltConnector;
}

export type RunReadOnlyMcpConnectorOptions = BuildReadOnlyMcpConnectorOptions;

function build(
  serverName: string,
  register: (reg: ZodToolRegistrar, server: unknown) => void,
  options: BuildReadOnlyMcpConnectorOptions | undefined,
): BuiltConnector {
  const make = options?.createConnector ?? createConnectorServer;
  const built = make({ name: serverName, version: "0.1.0" });
  const reg = createZodToolRegistrar(createRegisterSimpleTool(built.server));
  // The SERVER is passed to `register` as a second argument. Despite this helper's name, several
  // of its connectors expose write tools, and those need the server to build a consent registrar.
  // Optional in the callback's own signature, so the many genuinely read-only connectors that
  // ignore it are unaffected.
  register(reg, built.server);
  return built;
}

export function buildReadOnlyMcpConnector(
  serverName: string,
  register: (reg: ZodToolRegistrar, server: unknown) => void,
  options?: BuildReadOnlyMcpConnectorOptions,
): unknown {
  return build(serverName, register, options).server;
}

export async function runReadOnlyMcpConnector(
  serverName: string,
  register: (reg: ZodToolRegistrar, server: unknown) => void,
  options?: RunReadOnlyMcpConnectorOptions,
): Promise<void> {
  // Tools are registered before the server starts: one registered afterwards would be invisible
  // to a client that is already handshaking.
  await build(serverName, register, options).start();
}
