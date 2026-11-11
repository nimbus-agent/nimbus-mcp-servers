import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerGoogleCalendarTools } from "./tools.ts";

const server = new McpServer({ name: "nimbus-google-calendar", version: "0.1.0" });

registerGoogleCalendarTools(server);

await server.connect(new StdioServerTransport());
