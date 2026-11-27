import { createConnectorServer } from "../../../shared/connector-server.ts";
import { registerUnleashTools } from "./tools.ts";

const { server, start } = createConnectorServer({ name: "nimbus-unleash", version: "0.1.0" });

registerUnleashTools(server);

await start();
