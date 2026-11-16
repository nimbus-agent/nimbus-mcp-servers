import { createConnectorServer } from "../../../shared/connector-server.ts";
import { registerIacTools } from "./tools.ts";

const { server: mcp, start } = createConnectorServer({ name: "nimbus-iac", version: "0.1.0" });

registerIacTools(mcp);

await start();
