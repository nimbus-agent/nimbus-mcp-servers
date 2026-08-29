import { runReadOnlyMcpConnector } from "../../../shared/run-read-only-mcp-connector.ts";
import { registerSemgrepTools } from "./tools.ts";

await runReadOnlyMcpConnector("nimbus-semgrep", (reg) => {
  registerSemgrepTools(reg);
});
