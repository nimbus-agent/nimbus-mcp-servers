import { createConnectorServer } from "../../../shared/connector-server.ts";
import { registerGooglePhotosTools } from "./tools.ts";

const { server, start } = createConnectorServer({ name: "nimbus-google-photos", version: "0.1.0" });

registerGooglePhotosTools(server);

await start();
