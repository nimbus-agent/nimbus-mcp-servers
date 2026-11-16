import { createConnectorServer } from "../../../shared/connector-server.ts";
import { registerNetlifyTools } from "./tools.ts";

const { server, start } = createConnectorServer({ name: "nimbus-netlify", version: "0.1.0" });

registerNetlifyTools(server);

await start();
