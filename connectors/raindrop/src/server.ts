import { runReadOnlyMcpConnector } from "../../../shared/run-read-only-mcp-connector.ts";
import { registerRaindropTools } from "./tools.ts";

await runReadOnlyMcpConnector("nimbus-raindrop", (reg) => {
  registerRaindropTools(reg);
});
