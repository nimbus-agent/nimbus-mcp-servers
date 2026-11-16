import { createConnectorServer } from "../../../shared/connector-server.ts";
import { registerDiscordTools } from "./tools.ts";

const { server, start } = createConnectorServer(
  { name: "nimbus-discord", version: "0.1.0" },
  {
    // Machine-readable security tiering, so a client can surface it rather than relying on a
    // human having read the NOTICE file.
    instructions:
      "Nimbus Discord connector. Standalone: the message-post tool requires MCP elicitation " +
      "consent and is limited by NIMBUS_MCP_DISCORD_WRITE_SCOPE (channel:<id>); it is not " +
      "registered at all if this client does not support elicitation. No sandbox, no OS keychain " +
      "and no egress ledger outside the Nimbus gateway. See NOTICE.",
  },
);

registerDiscordTools(server);

await start();
