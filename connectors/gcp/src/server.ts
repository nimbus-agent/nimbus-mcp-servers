import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerGcpTools } from "./tools.ts";

const mcp = new McpServer({ name: "nimbus-gcp", version: "0.1.0" });

registerGcpTools(mcp);

const transport = new StdioServerTransport();
await mcp.connect(transport);
