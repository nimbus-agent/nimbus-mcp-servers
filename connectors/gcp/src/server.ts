import { createConnectorServer } from "../../../shared/connector-server.ts";
import { registerGcpTools } from "./tools.ts";

const { server: mcp, start } = createConnectorServer({ name: "nimbus-gcp", version: "0.1.0" });

registerGcpTools(mcp);

await start();
