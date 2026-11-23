import { type AllocationApi, registerAllocationTools } from "../../../shared/k8s-allocation.ts";
import type { ZodToolRegistrar } from "../../../shared/run-read-only-mcp-connector.ts";

/**
 * Kubecost (https://www.kubecost.com). Read-only: every request is a GET to the owner's own
 * cost-analyzer service (KUBECOST_URL, default port 9090, path `/model/allocation`). The reply
 * shapes were written from Kubecost's published allocation API page, not from a running instance
 * (UNVERIFIED).
 */
export const KUBECOST_API: AllocationApi = {
  service: "kubecost",
  label: "Kubecost",
  urlEnv: "KUBECOST_URL",
  tokenEnv: "KUBECOST_TOKEN",
  path: "/model/allocation",
  idleParam: "idle",
  sendStep: false,
};

/** Tool names exposed by this connector — for contract/introspection tests. */
export const KUBECOST_TOOL_NAMES = ["kubecost_allocation_list"] as const;

export function registerKubecostTools(reg: ZodToolRegistrar): void {
  registerAllocationTools(reg, KUBECOST_API);
}
