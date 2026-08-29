import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerTeamsTools } from "./tools.ts";

const server = new McpServer({ name: "nimbus-teams", version: "0.1.0" });

registerTeamsTools(server);

const transport = new StdioServerTransport();
await server.connect(transport);
