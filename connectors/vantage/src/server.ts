import { runReadOnlyMcpConnector } from "../../../shared/run-read-only-mcp-connector.ts";
import { registerVantageTools } from "./tools.ts";

await runReadOnlyMcpConnector("nimbus-vantage", (reg) => {
  registerVantageTools(reg);
});
