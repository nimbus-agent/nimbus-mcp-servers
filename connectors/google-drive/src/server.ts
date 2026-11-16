import { createConnectorServer } from "../../../shared/connector-server.ts";
import { registerGoogleDriveTools } from "./tools.ts";

const { server, start } = createConnectorServer({ name: "nimbus-google-drive", version: "0.1.0" });

registerGoogleDriveTools(server);

await start();
