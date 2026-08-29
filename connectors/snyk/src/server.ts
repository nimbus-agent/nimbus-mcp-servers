import { runReadOnlyMcpConnector } from "../../../shared/run-read-only-mcp-connector.ts";
import { registerSnykTools } from "./tools.ts";

await runReadOnlyMcpConnector("nimbus-snyk", (reg) => {
  registerSnykTools(reg);
});
