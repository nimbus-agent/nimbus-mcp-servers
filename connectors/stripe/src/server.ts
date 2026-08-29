import { runReadOnlyMcpConnector } from "../../../shared/run-read-only-mcp-connector.ts";
import { registerStripeTools } from "./tools.ts";

await runReadOnlyMcpConnector("nimbus-stripe", (reg) => {
  registerStripeTools(reg);
});
