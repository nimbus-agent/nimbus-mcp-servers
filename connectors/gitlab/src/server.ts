import { createConnectorServer } from "../../../shared/connector-server.ts";
import { registerGitlabTools } from "./tools.ts";

const { server, start } = createConnectorServer({ name: "nimbus-gitlab", version: "0.1.0" });

registerGitlabTools(server);

await start();
