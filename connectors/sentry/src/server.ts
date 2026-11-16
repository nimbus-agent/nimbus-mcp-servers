import { createConnectorServer } from "../../../shared/connector-server.ts";
import { registerSentryTools } from "./tools.ts";

const { server: mcp, start } = createConnectorServer({ name: "nimbus-sentry", version: "0.1.0" });

registerSentryTools(mcp);

await start();
