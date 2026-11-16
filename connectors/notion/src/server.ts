import { createConnectorServer } from "../../../shared/connector-server.ts";
import { registerNotionTools } from "./tools.ts";

const { server, start } = createConnectorServer({ name: "nimbus-notion", version: "0.1.0" });

registerNotionTools(server);

await start();
