import { runReadOnlyMcpConnector } from "../../../shared/run-read-only-mcp-connector.ts";
import { registerPrefectTools } from "./tools.ts";

await runReadOnlyMcpConnector("nimbus-prefect", (reg) => {
  registerPrefectTools(reg);
});
