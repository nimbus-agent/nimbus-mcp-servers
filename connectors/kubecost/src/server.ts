import { runReadOnlyMcpConnector } from "../../../shared/run-read-only-mcp-connector.ts";
import { registerKubecostTools } from "./tools.ts";

await runReadOnlyMcpConnector("nimbus-kubecost", (reg) => {
  registerKubecostTools(reg);
});
