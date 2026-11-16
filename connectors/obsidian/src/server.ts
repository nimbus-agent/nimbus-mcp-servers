import { createConnectorServer } from "../../../shared/connector-server.ts";
import { registerObsidianTools } from "./tools.ts";

const { server, start } = createConnectorServer({ name: "nimbus-obsidian", version: "0.1.0" });

registerObsidianTools(server);

await start();
