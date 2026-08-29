import { runReadOnlyMcpConnector } from "../../../shared/run-read-only-mcp-connector.ts";
import { registerCodemagicTools } from "./tools.ts";

await runReadOnlyMcpConnector("nimbus-codemagic", (reg) => {
  registerCodemagicTools(reg);
});
