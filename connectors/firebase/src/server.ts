import { createConnectorServer } from "../../../shared/connector-server.ts";
import { registerFirebaseTools } from "./tools.ts";

const { server, start } = createConnectorServer({ name: "nimbus-firebase", version: "0.1.0" });

registerFirebaseTools(server);

await start();
