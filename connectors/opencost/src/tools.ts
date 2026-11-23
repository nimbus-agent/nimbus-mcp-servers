import { type AllocationApi, registerAllocationTools } from "../../../shared/k8s-allocation.ts";
import type { ZodToolRegistrar } from "../../../shared/run-read-only-mcp-connector.ts";

/**
 * OpenCost (https://opencost.io, the CNCF cost-monitoring core). Read-only: every request is a GET
 * to the owner's own OpenCost service (OPENCOST_URL, default port 9003). The reply shapes were
 * written from OpenCost's published swagger file, not from a running instance (UNVERIFIED).
 */
export const OPENCOST_API: AllocationApi = {
  service: "opencost",
  label: "OpenCost",
  urlEnv: "OPENCOST_URL",
  tokenEnv: "OPENCOST_TOKEN",
  path: "/allocation",
  idleParam: "includeIdle",
  sendStep: true,
};

/** Tool names exposed by this connector — for contract/introspection tests. */
export const OPENCOST_TOOL_NAMES = ["opencost_allocation_list"] as const;

export function registerOpencostTools(reg: ZodToolRegistrar): void {
  registerAllocationTools(reg, OPENCOST_API);
}
