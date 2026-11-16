import { createConnectorServer } from "../../../shared/connector-server.ts";
import { registerGrafanaTools } from "./tools.ts";

const { server: mcp, start } = createConnectorServer({ name: "nimbus-grafana", version: "0.1.0" });

registerGrafanaTools(mcp);

await start();
