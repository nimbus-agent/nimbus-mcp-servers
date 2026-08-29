import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerGithubActionsTools } from "./tools.ts";

const mcp = new McpServer({ name: "nimbus-github-actions", version: "0.1.0" });

registerGithubActionsTools(mcp);

const transport = new StdioServerTransport();
await mcp.connect(transport);
