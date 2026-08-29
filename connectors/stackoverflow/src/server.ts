import { runReadOnlyMcpConnector } from "../../../shared/run-read-only-mcp-connector.ts";
import { registerStackoverflowTools } from "./tools.ts";

await runReadOnlyMcpConnector("nimbus-stackoverflow", (reg) => {
  registerStackoverflowTools(reg);
});
