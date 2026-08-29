import { runReadOnlyMcpConnector } from "../../../shared/run-read-only-mcp-connector.ts";
import { registerWizTools } from "./tools.ts";

await runReadOnlyMcpConnector("nimbus-wiz", (reg) => {
  registerWizTools(reg);
});
