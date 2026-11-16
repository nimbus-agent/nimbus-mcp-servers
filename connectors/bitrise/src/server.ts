import { createConnectorServer } from "../../../shared/connector-server.ts";
import { registerBitriseTools } from "./tools.ts";

const { server, start } = createConnectorServer({ name: "nimbus-bitrise", version: "0.1.0" });

registerBitriseTools(server);

await start();
