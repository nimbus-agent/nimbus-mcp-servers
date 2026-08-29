import { runReadOnlyMcpConnector } from "../../../shared/run-read-only-mcp-connector.ts";
import { registerHubspotTools } from "./tools.ts";

await runReadOnlyMcpConnector("nimbus-hubspot", (reg) => {
  registerHubspotTools(reg);
});
