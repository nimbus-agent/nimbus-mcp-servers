import { createConnectorServer } from "../../../shared/connector-server.ts";
import { registerCodemagicTools } from "./tools.ts";

const { server, start } = createConnectorServer({ name: "nimbus-codemagic", version: "0.1.0" });

registerCodemagicTools(server);

await start();
