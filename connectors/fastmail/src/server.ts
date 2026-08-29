import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createFetchJmapClient } from "./jmap-client.ts";
import { registerFastmailTools } from "./tools.ts";

const server = new McpServer({ name: "nimbus-fastmail", version: "0.1.0" });
registerFastmailTools(server, createFetchJmapClient());

await server.connect(new StdioServerTransport());
