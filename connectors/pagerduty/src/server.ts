import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CONSENT_SERVER_CAPABILITIES } from "../../../shared/consent-kit.ts";
import { registerPagerdutyTools } from "./tools.ts";

const mcp = new McpServer(
  { name: "nimbus-pagerduty", version: "0.1.0" },
  { capabilities: CONSENT_SERVER_CAPABILITIES },
);

registerPagerdutyTools(mcp);

const transport = new StdioServerTransport();
await mcp.connect(transport);
