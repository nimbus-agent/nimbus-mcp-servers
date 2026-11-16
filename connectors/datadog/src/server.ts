import { createConnectorServer } from "../../../shared/connector-server.ts";
import { registerDatadogTools } from "./tools.ts";

const { server: mcp, start } = createConnectorServer({ name: "nimbus-datadog", version: "0.1.0" });

registerDatadogTools(mcp);

await start();
