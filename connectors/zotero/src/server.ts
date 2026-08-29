import { runReadOnlyMcpConnector } from "../../../shared/run-read-only-mcp-connector.ts";
import { registerZoteroTools } from "./tools.ts";

await runReadOnlyMcpConnector("nimbus-zotero", (reg) => {
  registerZoteroTools(reg);
});
