import { createConnectorServer } from "../../../shared/connector-server.ts";
import { createFetchJmapClient } from "./jmap-client.ts";
import { registerFastmailTools } from "./tools.ts";

const { server, start } = createConnectorServer({ name: "nimbus-fastmail", version: "0.1.0" });
registerFastmailTools(server, createFetchJmapClient());

await start();
