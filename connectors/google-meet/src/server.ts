import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerGoogleMeetTools } from "./tools.ts";

const server = new McpServer({ name: "nimbus-google-meet", version: "0.1.0" });

registerGoogleMeetTools(server);

await server.connect(new StdioServerTransport());
