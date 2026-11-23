import { runReadOnlyMcpConnector } from "../../../shared/run-read-only-mcp-connector.ts";
import { registerOpencostTools } from "./tools.ts";

await runReadOnlyMcpConnector("nimbus-opencost", (reg) => {
  registerOpencostTools(reg);
});
