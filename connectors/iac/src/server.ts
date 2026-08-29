import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerIacTools } from "./tools.ts";

const mcp = new McpServer({ name: "nimbus-iac", version: "0.1.0" });

registerIacTools(mcp);

const transport = new StdioServerTransport();
await mcp.connect(transport);
