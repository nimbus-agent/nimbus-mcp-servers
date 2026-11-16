import { createConnectorServer } from "../../../shared/connector-server.ts";
import { registerNewrelicTools } from "./tools.ts";

const { server: mcp, start } = createConnectorServer({ name: "nimbus-newrelic", version: "0.1.0" });

registerNewrelicTools(mcp);

await start();
