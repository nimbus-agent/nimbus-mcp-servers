import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerGooglePhotosTools } from "./tools.ts";

const server = new McpServer({ name: "nimbus-google-photos", version: "0.1.0" });

registerGooglePhotosTools(server);

await server.connect(new StdioServerTransport());
