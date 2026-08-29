import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerJenkinsTools } from "./tools.ts";

const mcp = new McpServer({ name: "nimbus-jenkins", version: "0.1.0" });

registerJenkinsTools(mcp);

const transport = new StdioServerTransport();
await mcp.connect(transport);
