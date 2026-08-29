import { runReadOnlyMcpConnector } from "../../../shared/run-read-only-mcp-connector.ts";
import { registerDagsterTools } from "./tools.ts";

await runReadOnlyMcpConnector("nimbus-dagster", (reg) => {
  registerDagsterTools(reg);
});
