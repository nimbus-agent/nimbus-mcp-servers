import { runReadOnlyMcpConnector } from "../../../shared/run-read-only-mcp-connector.ts";
import { registerFigmaTools } from "./tools.ts";

await runReadOnlyMcpConnector("nimbus-figma", (reg) => {
  registerFigmaTools(reg);
});
