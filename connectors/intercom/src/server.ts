import { runReadOnlyMcpConnector } from "../../../shared/run-read-only-mcp-connector.ts";
import { registerIntercomTools } from "./tools.ts";

await runReadOnlyMcpConnector("nimbus-intercom", (reg) => {
  registerIntercomTools(reg);
});
