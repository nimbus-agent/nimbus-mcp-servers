import { runReadOnlyMcpConnector } from "../../../shared/run-read-only-mcp-connector.ts";
import { registerDependencytrackTools } from "./tools.ts";

await runReadOnlyMcpConnector("nimbus-dependencytrack", (reg) => {
  registerDependencytrackTools(reg);
});
