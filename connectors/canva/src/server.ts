import { runReadOnlyMcpConnector } from "../../../shared/run-read-only-mcp-connector.ts";
import { registerCanvaTools } from "./tools.ts";

await runReadOnlyMcpConnector("nimbus-canva", (reg) => {
  registerCanvaTools(reg);
});
