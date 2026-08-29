import { runReadOnlyMcpConnector } from "../../../shared/run-read-only-mcp-connector.ts";
import { registerSalesforceTools } from "./tools.ts";

await runReadOnlyMcpConnector("nimbus-salesforce", (reg) => {
  registerSalesforceTools(reg);
});
