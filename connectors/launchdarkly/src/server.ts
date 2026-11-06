import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CONSENT_SERVER_CAPABILITIES } from "../../../shared/consent-kit.ts";
import { registerLaunchdarklyTools } from "./tools.ts";

const server = new McpServer(
  { name: "nimbus-launchdarkly", version: "0.1.0" },
  { capabilities: CONSENT_SERVER_CAPABILITIES },
);

registerLaunchdarklyTools(server);

const transport = new StdioServerTransport();
await server.connect(transport);
