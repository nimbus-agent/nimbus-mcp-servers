import { runReadOnlyMcpConnector } from "../../../shared/run-read-only-mcp-connector.ts";
import { registerSonarqubeTools } from "./tools.ts";

await runReadOnlyMcpConnector("nimbus-sonarqube", (reg) => {
  registerSonarqubeTools(reg);
});
