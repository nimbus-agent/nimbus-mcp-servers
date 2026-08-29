import { runReadOnlyMcpConnector } from "../../../shared/run-read-only-mcp-connector.ts";
import { registerZendeskTools } from "./tools.ts";

await runReadOnlyMcpConnector("nimbus-zendesk", (reg) => {
  registerZendeskTools(reg);
});
