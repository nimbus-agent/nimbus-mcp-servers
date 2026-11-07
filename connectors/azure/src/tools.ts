import { z } from "zod";
import { azCliArg } from "../../../shared/cli-json-kit.ts";
import type { ConsentServer } from "../../../shared/consent-kit.ts";
import { createWriteToolRegistrar } from "../../../shared/consent-kit.ts";
import {
  createRegisterSimpleTool,
  createZodToolRegistrar,
  mcpJsonResult as jsonResult,
} from "../../../shared/mcp-tool-kit.ts";
import { runCliJsonThrowing, runCliOkThrowing } from "../../../shared/run-cli-json.ts";

function azEnv(): Record<string, string | undefined> {
  return { ...process.env } as Record<string, string | undefined>;
}

async function azJson(args: string[]): Promise<unknown> {
  const cmd = ["az", ...args, "-o", "json"];
  return (await runCliJsonThrowing(cmd, azEnv())) ?? {};
}

/**
 * The node-pool keys `az aks nodepool show` is projected to. The page
 * (https://learn.microsoft.com/en-us/cli/azure/aks/nodepool) does not list the output fields, so
 * only the keys PRESENT in the reply are kept and an absent one stays absent.
 */
const NODE_POOL_KEYS = [
  "count",
  "vmSize",
  "mode",
  "powerState",
  "provisioningState",
  "orchestratorVersion",
  "enableAutoScaling",
  "minCount",
  "maxCount",
] as const;

function projectNodePool(raw: unknown): Record<string, unknown> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("node pool not found");
  }
  const rec = raw as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of NODE_POOL_KEYS) {
    if (rec[k] !== undefined && rec[k] !== null) out[k] = rec[k];
  }
  // None of the keys present: not a node pool reply, so the owner is not shown an empty before-state.
  if (Object.keys(out).length === 0) throw new Error("node pool not found");
  // powerState is an object ({code}) in az's output; report its code as the plain string it is.
  const ps = out["powerState"];
  if (
    typeof ps === "object" &&
    ps !== null &&
    typeof (ps as { code?: unknown }).code === "string"
  ) {
    out["powerState"] = (ps as { code: string }).code;
  }
  return out;
}

/** Tool names exposed by this connector — for contract/introspection tests. */
export const AZURE_TOOL_NAMES = [
  "azure_app_service_list",
  "azure_aks_node_pool_get",
  "azure_app_service_restart",
  "azure_aks_node_pool_scale",
] as const;

export function registerAzureTools(
  server: ConsentServer & { tool: (...args: never) => unknown },
): void {
  const reg = createZodToolRegistrar(createRegisterSimpleTool(server));

  /**
   * Every MUTATING azure tool goes through here. Outside the gateway this adds the
   * consent gate, the write-scope allow-list, the mutation budget and the audit record; inside
   * the gateway it is a pass-through, because executor.ts (I2) is the gate there.
   */
  const registerWriteTool = createWriteToolRegistrar(server, {
    connector: "azure",
    scopeEnv: "NIMBUS_MCP_AZURE_WRITE_SCOPE",
    scopeKinds: ["resource_group"],
  });

  reg(
    "azure_app_service_list",
    "List App Services in a resource group.",
    z.object({
      subscriptionId: azCliArg,
      resourceGroup: azCliArg,
    }),
    async (p) =>
      jsonResult(
        await azJson([
          "webapp",
          "list",
          "--subscription",
          p.subscriptionId,
          "--resource-group",
          p.resourceGroup,
        ]),
      ),
  );

  reg(
    "azure_aks_node_pool_get",
    "Get one AKS node pool's state (count, vmSize, mode, powerState, provisioningState, orchestratorVersion, autoscaler bounds; absent keys omitted). The before-state of azure_aks_node_pool_scale; same keys.",
    z.object({
      subscriptionId: azCliArg,
      resourceGroup: azCliArg,
      clusterName: azCliArg,
      poolName: azCliArg,
    }),
    async (p) =>
      jsonResult(
        projectNodePool(
          await azJson([
            "aks",
            "nodepool",
            "show",
            "--subscription",
            p.subscriptionId,
            "--resource-group",
            p.resourceGroup,
            "--cluster-name",
            p.clusterName,
            "--name",
            p.poolName,
          ]),
        ),
      ),
  );

  registerWriteTool(
    "azure_app_service_restart",
    {
      mutates: "azure.app_service.restart",
      recoverable: true,
      scopeTargetOf: (p) => ({ kind: "resource_group", value: p.resourceGroup }),
    },
    "Restart an App Service.",
    z.object({
      subscriptionId: azCliArg,
      resourceGroup: azCliArg,
      name: azCliArg,
    }),
    async (p) => {
      await runCliOkThrowing(
        [
          "az",
          "webapp",
          "restart",
          "--subscription",
          p.subscriptionId,
          "--resource-group",
          p.resourceGroup,
          "--name",
          p.name,
        ],
        azEnv(),
      );
      return jsonResult({ ok: true });
    },
  );

  registerWriteTool(
    "azure_aks_node_pool_scale",
    {
      mutates: "azure.aks.node_pool.scale",
      recoverable: true,
      scopeTargetOf: (p) => ({ kind: "resource_group", value: p.resourceGroup }),
    },
    "Scale an AKS node pool.",
    z.object({
      subscriptionId: azCliArg,
      resourceGroup: azCliArg,
      clusterName: azCliArg,
      poolName: azCliArg,
      nodeCount: z.number().int().min(0),
    }),
    async (p) => {
      await runCliOkThrowing(
        [
          "az",
          "aks",
          "nodepool",
          "scale",
          "--subscription",
          p.subscriptionId,
          "--resource-group",
          p.resourceGroup,
          "--cluster-name",
          p.clusterName,
          "--name",
          p.poolName,
          "--node-count",
          String(p.nodeCount),
        ],
        azEnv(),
      );
      return jsonResult({ ok: true });
    },
  );
}
