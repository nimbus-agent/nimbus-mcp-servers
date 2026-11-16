import { createConnectorServer } from "../../../shared/connector-server.ts";
import { registerFlagsmithTools } from "./tools.ts";

const { server, start } = createConnectorServer({ name: "nimbus-flagsmith", version: "0.1.0" });

registerFlagsmithTools(server);

await start();
