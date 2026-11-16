import { createConnectorServer } from "../../../shared/connector-server.ts";
import { registerConfluenceTools } from "./tools.ts";

const { server, start } = createConnectorServer({ name: "nimbus-confluence", version: "0.1.0" });

registerConfluenceTools(server);

await start();
