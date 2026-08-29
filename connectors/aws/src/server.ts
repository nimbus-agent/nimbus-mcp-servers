import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerAwsTools } from "./tools.ts";

const mcp = new McpServer({ name: "nimbus-aws", version: "0.1.0" });

registerAwsTools(mcp);

const transport = new StdioServerTransport();
await mcp.connect(transport);
