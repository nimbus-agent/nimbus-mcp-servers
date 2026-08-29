import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerGmailTools } from "./tools.ts";

const server = new McpServer({ name: "nimbus-gmail", version: "0.1.0" });

registerGmailTools(server);

await server.connect(new StdioServerTransport());
