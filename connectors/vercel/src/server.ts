import { runReadOnlyMcpConnector } from "../../../shared/run-read-only-mcp-connector.ts";
import { registerVercelTools } from "./tools.ts";

await runReadOnlyMcpConnector("nimbus-vercel", (reg) => {
  registerVercelTools(reg);
});
