import { runReadOnlyMcpConnector } from "../../../shared/run-read-only-mcp-connector.ts";
import { registerAirflowTools } from "./tools.ts";

await runReadOnlyMcpConnector("nimbus-airflow", (reg) => {
  registerAirflowTools(reg);
});
