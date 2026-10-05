import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CONSENT_SERVER_CAPABILITIES } from "../../../shared/consent-kit.ts";
import { createFetchJmapClient } from "./jmap-client.ts";
import { registerFastmailTools } from "./tools.ts";

const server = new McpServer(
  { name: "nimbus-fastmail", version: "0.1.0" },
  { capabilities: CONSENT_SERVER_CAPABILITIES },
);
registerFastmailTools(server, createFetchJmapClient());

await server.connect(new StdioServerTransport());
