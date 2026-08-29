import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerPagerdutyTools } from "./tools.ts";

const mcp = new McpServer({ name: "nimbus-pagerduty", version: "0.1.0" });

registerPagerdutyTools(mcp);

const transport = new StdioServerTransport();
await mcp.connect(transport);
