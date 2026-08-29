import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerDatadogTools } from "./tools.ts";

const mcp = new McpServer({ name: "nimbus-datadog", version: "0.1.0" });

registerDatadogTools(mcp);

const transport = new StdioServerTransport();
await mcp.connect(transport);
