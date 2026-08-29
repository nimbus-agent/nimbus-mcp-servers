import { runReadOnlyMcpConnector } from "../../../shared/run-read-only-mcp-connector.ts";
import { registerDbtTools } from "./tools.ts";

await runReadOnlyMcpConnector("nimbus-dbt", (reg) => {
  registerDbtTools(reg);
});
