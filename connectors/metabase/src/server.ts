import { runReadOnlyMcpConnector } from "../../../shared/run-read-only-mcp-connector.ts";
import { registerMetabaseTools } from "./tools.ts";

await runReadOnlyMcpConnector("nimbus-metabase", (reg) => {
  registerMetabaseTools(reg);
});
