/**
 * The ONE place a connector's MCP server is built and started.
 *
 * Which server depends on who started the process (`shared/connector-mode.ts`):
 *
 * - `"gateway"`: the upstream MCP SDK's `McpServer` on a `StdioServerTransport`, exactly as
 *   before. The Nimbus gateway talks to its connectors with the upstream client and approves
 *   their writes itself, so nothing about that path changes.
 * - `"standalone"` (the default): the layer server (`shared/layer-server.ts`), which answers a
 *   client of MCP revision 2026-07-28 as well as one that opens with `initialize`, and through
 *   which a write tool asks the client for consent.
 *
 * `scripts/connector-server-chokepoint.test.ts` fails any other file that constructs an upstream
 * server or a stdio server transport.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { getConnectorMode } from "./connector-mode.ts";
import { CONSENT_SERVER_CAPABILITIES, type ConsentServer } from "./consent-kit.ts";
import { createLayerServer } from "./layer-server.ts";

export interface ConnectorServerOptions {
  /** Sent to the client as the server's instructions, by whichever server is built. */
  readonly instructions?: string;
}

export interface ConnectorServer {
  /** What tools are registered on, and what the consent kit's registrars take. */
  readonly server: ConsentServer;
  /** Starts serving on this process's stdio; resolves once it is serving. */
  start(): Promise<void>;
}

export function createConnectorServer(
  info: { readonly name: string; readonly version: string },
  options: ConnectorServerOptions = {},
): ConnectorServer {
  const instructions =
    options.instructions === undefined ? {} : { instructions: options.instructions };
  if (getConnectorMode() === "gateway") {
    // The `logging` capability must be declared at construction: see CONSENT_SERVER_CAPABILITIES.
    const mcp = new McpServer(info, { capabilities: CONSENT_SERVER_CAPABILITIES, ...instructions });
    return { server: mcp, start: () => mcp.connect(new StdioServerTransport()) };
  }
  const layer = createLayerServer(info, instructions);
  return { server: layer, start: () => layer.connect() };
}
