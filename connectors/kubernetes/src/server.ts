import { createConnectorServer } from "../../../shared/connector-server.ts";
import { registerKubernetesTools } from "./tools.ts";

const { server: mcp, start } = createConnectorServer({
  name: "nimbus-kubernetes",
  version: "0.1.0",
});

registerKubernetesTools(mcp);

await start();
