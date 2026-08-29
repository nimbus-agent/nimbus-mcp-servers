import { runReadOnlyMcpConnector } from "../../../shared/run-read-only-mcp-connector.ts";
import { registerBitriseTools } from "./tools.ts";

await runReadOnlyMcpConnector("nimbus-bitrise", (reg) => {
  registerBitriseTools(reg);
});
