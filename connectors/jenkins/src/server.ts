import { createConnectorServer } from "../../../shared/connector-server.ts";
import { registerJenkinsTools } from "./tools.ts";

const { server: mcp, start } = createConnectorServer({ name: "nimbus-jenkins", version: "0.1.0" });

registerJenkinsTools(mcp);

await start();
