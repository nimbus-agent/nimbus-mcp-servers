import { runReadOnlyMcpConnector } from "../../../shared/run-read-only-mcp-connector.ts";
import { registerRampTools } from "./tools.ts";

await runReadOnlyMcpConnector("nimbus-ramp", (reg) => {
  registerRampTools(reg);
});
