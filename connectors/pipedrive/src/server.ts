import { runReadOnlyMcpConnector } from "../../../shared/run-read-only-mcp-connector.ts";
import { registerPipedriveTools } from "./tools.ts";

await runReadOnlyMcpConnector("nimbus-pipedrive", (reg) => {
  registerPipedriveTools(reg);
});
