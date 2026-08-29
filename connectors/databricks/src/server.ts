import { runReadOnlyMcpConnector } from "../../../shared/run-read-only-mcp-connector.ts";
import { registerDatabricksTools } from "./tools.ts";

await runReadOnlyMcpConnector("nimbus-databricks", (reg) => {
  registerDatabricksTools(reg);
});
