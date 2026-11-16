import { createConnectorServer } from "../../../shared/connector-server.ts";
import { registerGoogleMeetTools } from "./tools.ts";

const { server, start } = createConnectorServer({ name: "nimbus-google-meet", version: "0.1.0" });

registerGoogleMeetTools(server);

await start();
