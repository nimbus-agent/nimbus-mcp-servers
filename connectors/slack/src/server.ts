import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerSlackTools } from "./tools.ts";

const server = new McpServer({ name: "nimbus-slack", version: "0.1.0" });

registerSlackTools(server);

const transport = new StdioServerTransport();
await server.connect(transport);
