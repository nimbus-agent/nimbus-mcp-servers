import { createConnectorServer } from "../../../shared/connector-server.ts";
import { registerSlackTools } from "./tools.ts";

const { server, start } = createConnectorServer({ name: "nimbus-slack", version: "0.1.0" });

registerSlackTools(server);

await start();
