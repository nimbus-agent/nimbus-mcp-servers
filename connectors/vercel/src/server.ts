import { createConnectorServer } from "../../../shared/connector-server.ts";
import { registerVercelTools } from "./tools.ts";

const { server, start } = createConnectorServer({ name: "nimbus-vercel", version: "0.1.0" });

registerVercelTools(server);

await start();
