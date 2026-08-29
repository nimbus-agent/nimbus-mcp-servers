import { runReadOnlyMcpConnector } from "../../../shared/run-read-only-mcp-connector.ts";
import { registerGreenhouseTools } from "./tools.ts";

await runReadOnlyMcpConnector("nimbus-greenhouse", (reg) => {
  registerGreenhouseTools(reg);
});
