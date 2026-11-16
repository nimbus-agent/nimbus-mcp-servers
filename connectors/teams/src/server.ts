import { createConnectorServer } from "../../../shared/connector-server.ts";
import { registerTeamsTools } from "./tools.ts";

const { server, start } = createConnectorServer({ name: "nimbus-teams", version: "0.1.0" });

registerTeamsTools(server);

await start();
