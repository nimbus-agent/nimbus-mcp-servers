import { createConnectorServer } from "../../../shared/connector-server.ts";
import { registerOnedriveTools } from "./tools.ts";

const { server, start } = createConnectorServer({ name: "nimbus-onedrive", version: "0.1.0" });

registerOnedriveTools(server);

await start();
