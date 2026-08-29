import { runReadOnlyMcpConnector } from "../../../shared/run-read-only-mcp-connector.ts";
import { registerMendeleyTools } from "./tools.ts";

await runReadOnlyMcpConnector("nimbus-mendeley", (reg) => {
  registerMendeleyTools(reg);
});
