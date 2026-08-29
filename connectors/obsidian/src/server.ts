import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerObsidianTools } from "./tools.ts";

const server = new McpServer({ name: "nimbus-obsidian", version: "0.1.0" });

registerObsidianTools(server);

const transport = new StdioServerTransport();
await server.connect(transport);
