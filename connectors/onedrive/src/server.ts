import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerOnedriveTools } from "./tools.ts";

const server = new McpServer({ name: "nimbus-onedrive", version: "0.1.0" });

registerOnedriveTools(server);

await server.connect(new StdioServerTransport());
