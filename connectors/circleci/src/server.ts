import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerCircleciTools } from "./tools.ts";

const mcp = new McpServer({ name: "nimbus-circleci", version: "0.1.0" });

registerCircleciTools(mcp);

const transport = new StdioServerTransport();
await mcp.connect(transport);
