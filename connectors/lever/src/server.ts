import { runReadOnlyMcpConnector } from "../../../shared/run-read-only-mcp-connector.ts";
import { registerLeverTools } from "./tools.ts";

await runReadOnlyMcpConnector("nimbus-lever", (reg) => {
  registerLeverTools(reg);
});
