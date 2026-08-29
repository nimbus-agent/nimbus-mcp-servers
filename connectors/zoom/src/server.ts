import { runReadOnlyMcpConnector } from "../../../shared/run-read-only-mcp-connector.ts";
import { registerZoomTools } from "./tools.ts";

await runReadOnlyMcpConnector("nimbus-zoom", (reg) => {
  registerZoomTools(reg);
});
