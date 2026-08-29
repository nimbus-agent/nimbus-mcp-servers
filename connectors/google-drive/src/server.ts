import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerGoogleDriveTools } from "./tools.ts";

const server = new McpServer({ name: "nimbus-google-drive", version: "0.1.0" });

registerGoogleDriveTools(server);

await server.connect(new StdioServerTransport());
