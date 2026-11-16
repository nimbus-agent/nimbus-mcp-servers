import { createConnectorServer } from "../../../shared/connector-server.ts";
import { registerLaunchdarklyTools } from "./tools.ts";

const { server, start } = createConnectorServer({ name: "nimbus-launchdarkly", version: "0.1.0" });

registerLaunchdarklyTools(server);

await start();
