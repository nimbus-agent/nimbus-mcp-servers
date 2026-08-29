import { runReadOnlyMcpConnector } from "../../../shared/run-read-only-mcp-connector.ts";
import { registerMiroTools } from "./tools.ts";

await runReadOnlyMcpConnector("nimbus-miro", (reg) => {
  registerMiroTools(reg);
});
