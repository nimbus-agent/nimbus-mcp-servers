import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerConfluenceTools } from "./tools.ts";

const server = new McpServer({ name: "nimbus-confluence", version: "0.1.0" });

registerConfluenceTools(server);

const transport = new StdioServerTransport();
await server.connect(transport);
