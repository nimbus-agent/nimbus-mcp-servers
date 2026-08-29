import { runReadOnlyMcpConnector } from "../../../shared/run-read-only-mcp-connector.ts";
import { registerReadwiseTools } from "./tools.ts";

await runReadOnlyMcpConnector("nimbus-readwise", (reg) => {
  registerReadwiseTools(reg);
});
