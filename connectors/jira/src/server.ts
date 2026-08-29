import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerJiraTools } from "./tools.ts";

const server = new McpServer({ name: "nimbus-jira", version: "0.1.0" });

registerJiraTools(server);

const transport = new StdioServerTransport();
await server.connect(transport);
