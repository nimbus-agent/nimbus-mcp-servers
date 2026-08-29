import { runReadOnlyMcpConnector } from "../../../shared/run-read-only-mcp-connector.ts";
import { registerFlagsmithTools } from "./tools.ts";

await runReadOnlyMcpConnector("nimbus-flagsmith", (reg) => {
  registerFlagsmithTools(reg);
});
