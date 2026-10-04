import { z } from "zod";
import { gcloudEnv } from "../../../shared/cli-json-kit.ts";
import type { ConsentServer } from "../../../shared/consent-kit.ts";
import { createWriteToolRegistrar } from "../../../shared/consent-kit.ts";
import {
  createRegisterSimpleTool,
  createZodToolRegistrar,
  mcpJsonResult as jsonResult,
} from "../../../shared/mcp-tool-kit.ts";
import { runCliJsonThrowing, runCliOkThrowing } from "../../../shared/run-cli-json.ts";

async function gcloudJson(args: string[]): Promise<unknown> {
  const cmd = ["gcloud", ...args, "--format", "json"];
  return (await runCliJsonThrowing(cmd, gcloudEnv())) ?? {};
}

/** Tool names exposed by this connector — for contract/introspection tests. */
export const GCP_TOOL_NAMES = [
  "gcp_cloud_run_service_list",
  "gcp_cloud_run_deploy",
  "gcp_gke_workload_restart",
] as const;

export function registerGcpTools(
  server: ConsentServer & { tool: (...args: never) => unknown },
): void {
  const reg = createZodToolRegistrar(createRegisterSimpleTool(server));

  /**
   * Every MUTATING gcp tool goes through here. Outside the gateway this adds the
   * consent gate, the write-scope allow-list, the mutation budget and the audit record; inside
   * the gateway it is a pass-through, because executor.ts (I2) is the gate there.
   */
  const registerWriteTool = createWriteToolRegistrar(server, {
    connector: "gcp",
    scopeEnv: "NIMBUS_MCP_GCP_WRITE_SCOPE",
    scopeKinds: ["project"],
  });

  reg(
    "gcp_cloud_run_service_list",
    "List Cloud Run services in a region.",
    z.object({ projectId: z.string().min(1), region: z.string().min(1) }),
    async (p) =>
      jsonResult(
        await gcloudJson([
          "run",
          "services",
          "list",
          `--project=${p.projectId}`,
          `--region=${p.region}`,
        ]),
      ),
  );

  registerWriteTool(
    "gcp_cloud_run_deploy",
    {
      mutates: "gcp.cloud_run.deploy",
      recoverable: true,
      scopeTargetOf: (p) => ({ kind: "project", value: p.projectId }),
    },
    "Deploy a container image to Cloud Run.",
    z.object({
      projectId: z.string().min(1),
      region: z.string().min(1),
      service: z.string().min(1),
      image: z.string().min(1),
    }),
    async (p) => {
      await runCliOkThrowing(
        [
          "gcloud",
          "run",
          "deploy",
          p.service,
          `--project=${p.projectId}`,
          `--region=${p.region}`,
          `--image=${p.image}`,
          "--quiet",
        ],
        gcloudEnv(),
      );
      return jsonResult({ ok: true });
    },
  );

  registerWriteTool(
    "gcp_gke_workload_restart",
    {
      mutates: "gcp.gke.workload.restart",
      recoverable: true,
      scopeTargetOf: (p) => ({ kind: "project", value: p.projectId }),
    },
    "Restart a GKE deployment rollout via kubectl (uses current cluster credentials).",
    z.object({
      projectId: z.string().min(1),
      location: z.string().min(1),
      cluster: z.string().min(1),
      namespace: z.string().min(1),
      deployment: z.string().min(1),
    }),
    async (p) => {
      await runCliOkThrowing(
        [
          "gcloud",
          "container",
          "clusters",
          "get-credentials",
          p.cluster,
          `--project=${p.projectId}`,
          `--zone=${p.location}`,
        ],
        gcloudEnv(),
      );
      await runCliOkThrowing(
        ["kubectl", "rollout", "restart", "deployment", p.deployment, "-n", p.namespace],
        gcloudEnv(),
      );
      return jsonResult({ ok: true });
    },
  );
}
