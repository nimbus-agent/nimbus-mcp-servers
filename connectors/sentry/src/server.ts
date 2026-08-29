import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerSentryTools } from "./tools.ts";

const mcp = new McpServer({ name: "nimbus-sentry", version: "0.1.0" });

registerSentryTools(mcp);

const transport = new StdioServerTransport();
await mcp.connect(transport);
