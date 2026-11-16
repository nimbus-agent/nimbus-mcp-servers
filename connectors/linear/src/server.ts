import { createConnectorServer } from "../../../shared/connector-server.ts";
import { registerLinearTools } from "./tools.ts";

const { server, start } = createConnectorServer({ name: "nimbus-linear", version: "0.1.0" });

registerLinearTools(server);

await start();
