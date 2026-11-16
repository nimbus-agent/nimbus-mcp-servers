import { createConnectorServer } from "../../../shared/connector-server.ts";
import { registerGoogleCalendarTools } from "./tools.ts";

const { server, start } = createConnectorServer({
  name: "nimbus-google-calendar",
  version: "0.1.0",
});

registerGoogleCalendarTools(server);

await start();
