import { createConnectorServer } from "../../../shared/connector-server.ts";
import { registerTestflightTools } from "./tools.ts";

const { server, start } = createConnectorServer({ name: "nimbus-testflight", version: "0.1.0" });

registerTestflightTools(server);

await start();
