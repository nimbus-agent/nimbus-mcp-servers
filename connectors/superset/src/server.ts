import { runReadOnlyMcpConnector } from "../../../shared/run-read-only-mcp-connector.ts";
import { registerSupersetTools } from "./tools.ts";

await runReadOnlyMcpConnector("nimbus-superset", (reg) => {
  registerSupersetTools(reg);
});
