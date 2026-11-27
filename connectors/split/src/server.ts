import { createConnectorServer } from "../../../shared/connector-server.ts";
import { registerSplitTools } from "./tools.ts";

const { server, start } = createConnectorServer({ name: "nimbus-split", version: "0.1.0" });

registerSplitTools(server);

await start();
