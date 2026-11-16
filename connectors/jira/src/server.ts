import { createConnectorServer } from "../../../shared/connector-server.ts";
import { registerJiraTools } from "./tools.ts";

const { server, start } = createConnectorServer({ name: "nimbus-jira", version: "0.1.0" });

registerJiraTools(server);

await start();
