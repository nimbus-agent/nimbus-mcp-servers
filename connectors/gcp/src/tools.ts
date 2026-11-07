import { z } from "zod";
import { cliArg, gcloudEnv } from "../../../shared/cli-json-kit.ts";
import type { ConsentServer } from "../../../shared/consent-kit.ts";
import { createWriteToolRegistrar } from "../../../shared/consent-kit.ts";
import { isKubectlNotFound, projectDeployment } from "../../../shared/k8s-deployment-view.ts";
import {
  createRegisterSimpleTool,
  createZodToolRegistrar,
  mcpJsonResult as jsonResult,
} from "../../../shared/mcp-tool-kit.ts";
import { withPrivateKubeconfig } from "../../../shared/private-kubeconfig.ts";
import { runCliJsonThrowing, runCliOkThrowing } from "../../../shared/run-cli-json.ts";

async function gcloudJson(args: string[]): Promise<unknown> {
  const cmd = ["gcloud", ...args, "--format", "json"];
  return (await runCliJsonThrowing(cmd, gcloudEnv())) ?? {};
}

type GkeTarget = {
  readonly projectId: string;
  readonly location: string;
  readonly cluster: string;
};

/**
 * Run `body` with credentials for one GKE cluster in a PRIVATE kubeconfig: a fresh empty file,
 * which `get-credentials` fills (it writes `$HOME/.kube/config` only when `KUBECONFIG` is unset,
 * so the owner's file is never touched). `--location` is gcloud's own preferred flag and, unlike
 * `--zone`, also names a regional cluster.
 * https://docs.cloud.google.com/sdk/gcloud/reference/container/clusters/get-credentials
 */
function withGkeCredentials<T>(
  t: GkeTarget,
  body: (env: Record<string, string | undefined>) => Promise<T>,
): Promise<T> {
  return withPrivateKubeconfig({}, async (kube) => {
    const env = { ...gcloudEnv(), ...kube };
    await runCliOkThrowing(
      [
        "gcloud",
        "container",
        "clusters",
        "get-credentials",
        t.cluster,
        `--project=${t.projectId}`,
        `--location=${t.location}`,
      ],
      env,
    );
    return body(env);
  });
}

/** Tool names exposed by this connector — for contract/introspection tests. */
export const GCP_TOOL_NAMES = [
  "gcp_cloud_run_service_list",
  "gcp_cloud_run_deploy",
  "gcp_gke_workload_restart",
  "gcp_gke_workload_get",
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
    z.object({ projectId: cliArg, region: cliArg }),
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
      projectId: cliArg,
      region: cliArg,
      service: cliArg,
      image: cliArg,
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
    "Restart a GKE deployment rollout via kubectl, with cluster credentials fetched into a private kubeconfig (the owner's kubeconfig is never read or changed).",
    z.object({
      projectId: cliArg,
      location: cliArg,
      cluster: cliArg,
      namespace: cliArg,
      deployment: cliArg,
    }),
    async (p) => {
      await withGkeCredentials(p, (env) =>
        runCliOkThrowing(
          ["kubectl", "rollout", "restart", "deployment", p.deployment, "-n", p.namespace],
          env,
        ),
      );
      return jsonResult({ ok: true });
    },
  );

  reg(
    "gcp_gke_workload_get",
    "Get one GKE deployment's state: {name, namespace, replicas, readyReplicas, generation, observedGeneration, restartedAt, images}. The before-state of gcp_gke_workload_restart; it takes the same arguments.",
    z.object({
      projectId: cliArg,
      location: cliArg,
      cluster: cliArg,
      namespace: cliArg,
      deployment: cliArg,
    }),
    async (p) => {
      // NotFound is read from the kubectl step ONLY: a get-credentials failure ("cluster not found")
      // is a different problem and must reach the caller as itself.
      const data = await withGkeCredentials(p, async (env) => {
        try {
          return await runCliJsonThrowing(
            ["kubectl", "get", "deployment", p.deployment, "-n", p.namespace, "-o", "json"],
            env,
          );
        } catch (e) {
          if (e instanceof Error && isKubectlNotFound(e.message)) {
            throw new Error("deployment not found", { cause: e });
          }
          throw e;
        }
      });
      return jsonResult(projectDeployment(data));
    },
  );
}
