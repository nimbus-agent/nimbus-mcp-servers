import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerGithubTools } from "./tools.ts";

const server = new McpServer(
  { name: "nimbus-github", version: "0.1.0" },
  {
    // Machine-readable security tiering, so a client can surface it rather than relying on a
    // human having read the NOTICE file.
    instructions:
      "Nimbus GitHub connector. Standalone: mutating tools require MCP elicitation consent and " +
      "are limited by NIMBUS_MCP_GITHUB_WRITE_SCOPE; they are not registered at all if this " +
      "client does not support elicitation. No sandbox, no OS keychain and no egress ledger " +
      "outside the Nimbus gateway. See NOTICE.",
  },
);

registerGithubTools(server);

const transport = new StdioServerTransport();
await server.connect(transport);
