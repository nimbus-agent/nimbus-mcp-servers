import { createConnectorServer } from "../../../shared/connector-server.ts";
import { registerBitbucketTools } from "./tools.ts";

const { server, start } = createConnectorServer({ name: "nimbus-bitbucket", version: "0.1.0" });

registerBitbucketTools(server);

await start();
