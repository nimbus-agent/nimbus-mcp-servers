import { createConnectorServer } from "../../../shared/connector-server.ts";
import { registerPagerdutyTools } from "./tools.ts";

const { server: mcp, start } = createConnectorServer({
  name: "nimbus-pagerduty",
  version: "0.1.0",
});

registerPagerdutyTools(mcp);

await start();
