import { createConnectorServer } from "../../../shared/connector-server.ts";
import { registerGithubActionsTools } from "./tools.ts";

const { server: mcp, start } = createConnectorServer({
  name: "nimbus-github-actions",
  version: "0.1.0",
});

registerGithubActionsTools(mcp);

await start();
