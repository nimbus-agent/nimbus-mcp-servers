import { runReadOnlyMcpConnector } from "../../../shared/run-read-only-mcp-connector.ts";
import { registerLaunchdarklyTools } from "./tools.ts";

await runReadOnlyMcpConnector("nimbus-launchdarkly", (reg) => {
  registerLaunchdarklyTools(reg);
});
