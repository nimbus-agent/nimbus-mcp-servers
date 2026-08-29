import { runReadOnlyMcpConnector } from "../../../shared/run-read-only-mcp-connector.ts";
import { registerTestflightTools } from "./tools.ts";

await runReadOnlyMcpConnector("nimbus-testflight", (reg) => {
  registerTestflightTools(reg);
});
