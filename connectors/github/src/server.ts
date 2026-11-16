import { createConnectorServer } from "../../../shared/connector-server.ts";
import { registerGithubTools } from "./tools.ts";

const { server, start } = createConnectorServer(
  { name: "nimbus-github", version: "0.1.0" },
  {
    // Machine-readable security tiering, so a client can surface it rather than relying on a
    // human having read the NOTICE file.
    instructions:
      "Nimbus GitHub connector. Standalone: mutating tools require MCP elicitation consent and " +
      "are limited by NIMBUS_MCP_GITHUB_WRITE_SCOPE; they are not listed, and are refused, if this " +
      "client does not support elicitation. No sandbox, no OS keychain and no egress ledger " +
      "outside the Nimbus gateway. See NOTICE.",
  },
);

registerGithubTools(server);

await start();
