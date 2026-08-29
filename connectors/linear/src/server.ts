import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerLinearTools } from "./tools.ts";

const server = new McpServer({ name: "nimbus-linear", version: "0.1.0" });

registerLinearTools(server);

const transport = new StdioServerTransport();
await server.connect(transport);
