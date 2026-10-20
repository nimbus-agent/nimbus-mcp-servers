// Entry point of the signed Readwise extension (bundled to dist/server.js by `build:extension`).
// Kept apart from server.ts so the standalone/gateway entry stays untouched; bootstrap only.
import { runReadOnlyMcpConnector } from "../../../shared/run-read-only-mcp-connector.ts";
import { registerReadwiseTools } from "./tools.ts";

await runReadOnlyMcpConnector("nimbus-readwise", (reg) => {
  registerReadwiseTools(reg);
});
