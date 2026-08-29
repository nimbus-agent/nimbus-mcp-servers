import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerGrafanaTools } from "./tools.ts";

const mcp = new McpServer({ name: "nimbus-grafana", version: "0.1.0" });

registerGrafanaTools(mcp);

const transport = new StdioServerTransport();
await mcp.connect(transport);
