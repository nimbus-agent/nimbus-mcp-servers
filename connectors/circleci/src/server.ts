import { createConnectorServer } from "../../../shared/connector-server.ts";
import { registerCircleciTools } from "./tools.ts";

const { server: mcp, start } = createConnectorServer({ name: "nimbus-circleci", version: "0.1.0" });

registerCircleciTools(mcp);

await start();
