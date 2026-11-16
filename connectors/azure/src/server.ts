import { createConnectorServer } from "../../../shared/connector-server.ts";
import { registerAzureTools } from "./tools.ts";

const { server: mcp, start } = createConnectorServer({ name: "nimbus-azure", version: "0.1.0" });

registerAzureTools(mcp);

await start();
