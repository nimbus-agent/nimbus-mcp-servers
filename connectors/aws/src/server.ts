import { createConnectorServer } from "../../../shared/connector-server.ts";
import { registerAwsTools } from "./tools.ts";

const { server: mcp, start } = createConnectorServer({ name: "nimbus-aws", version: "0.1.0" });

registerAwsTools(mcp);

await start();
