import { runReadOnlyMcpConnector } from "../../../shared/run-read-only-mcp-connector.ts";
import { registerFirebaseTools } from "./tools.ts";

await runReadOnlyMcpConnector("nimbus-firebase", (reg) => {
  registerFirebaseTools(reg);
});
