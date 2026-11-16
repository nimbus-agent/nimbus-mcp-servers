import { createConnectorServer } from "../../../shared/connector-server.ts";
import { registerOutlookTools } from "./tools.ts";

const { server, start } = createConnectorServer({ name: "nimbus-outlook", version: "0.1.0" });

registerOutlookTools(server);

await start();
