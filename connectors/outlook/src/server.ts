import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CONSENT_SERVER_CAPABILITIES } from "../../../shared/consent-kit.ts";
import { registerOutlookTools } from "./tools.ts";

const server = new McpServer(
  { name: "nimbus-outlook", version: "0.1.0" },
  { capabilities: CONSENT_SERVER_CAPABILITIES },
);

registerOutlookTools(server);

await server.connect(new StdioServerTransport());
