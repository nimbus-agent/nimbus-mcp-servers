import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerGitlabTools } from "./tools.ts";

const server = new McpServer({ name: "nimbus-gitlab", version: "0.1.0" });

registerGitlabTools(server);

const transport = new StdioServerTransport();
await server.connect(transport);
