import { runReadOnlyMcpConnector } from "../../../shared/run-read-only-mcp-connector.ts";
import { registerMercuryTools } from "./tools.ts";

await runReadOnlyMcpConnector("nimbus-mercury", (reg) => {
  registerMercuryTools(reg);
});
