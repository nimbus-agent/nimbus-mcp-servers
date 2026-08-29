import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerDiscordTools } from "./tools.ts";

const server = new McpServer({ name: "nimbus-discord", version: "0.1.0" });

registerDiscordTools(server);

const transport = new StdioServerTransport();
await server.connect(transport);
