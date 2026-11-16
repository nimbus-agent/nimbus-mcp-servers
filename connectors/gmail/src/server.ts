import { createConnectorServer } from "../../../shared/connector-server.ts";
import { registerGmailTools } from "./tools.ts";

const { server, start } = createConnectorServer({ name: "nimbus-gmail", version: "0.1.0" });

registerGmailTools(server);

await start();
