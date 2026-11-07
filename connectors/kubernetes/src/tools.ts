import { z } from "zod";
import { cliArg } from "../../../shared/cli-json-kit.ts";
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

function kubectlBase(): string[] {
  const args = ["kubectl"];
  const ctx = process.env["KUBE_CONTEXT"]?.trim();
  if (ctx !== undefined && ctx !== "") {
    args.push("--context", ctx);
  }
  return args;
}

/**
 * Run `body` against a private copy of the kubeconfig `KUBECONFIG` names (shared/private-kubeconfig.ts):
 * one tool call, one copy, so a call can neither change the owner's file nor race another call.
 */
function withKube<T>(body: (env: { readonly KUBECONFIG: string }) => Promise<T>): Promise<T> {
  return withPrivateKubeconfig({ source: process.env["KUBECONFIG"] ?? "" }, body);
}

function kubectlJson(rest: string[]): Promise<unknown> {
  const cmd = [...kubectlBase(), ...rest, "-o", "json"];
  return withKube((env) => runCliJsonThrowing(cmd, env));
}

const optionalNamespaceSchema = z.object({ namespace: cliArg.optional() });

async function k8sListNamespacedResource(p: { namespace?: string | undefined }, resource: string) {
  const ns = p.namespace ?? "default";
  const data = await kubectlJson(["get", resource, "-n", ns]);
  return jsonResult(data ?? {});
}

/** Tool names exposed by this connector — for contract/introspection tests. */
export const KUBERNETES_TOOL_NAMES = [
  "k8s_pod_list",
  "k8s_deployment_get",
  "k8s_deployment_list",
  "k8s_event_list",
  "k8s_rollout_restart",
  "k8s_pod_delete",
  "k8s_deployment_scale",
] as const;

export function registerKubernetesTools(
  server: ConsentServer & { tool: (...args: never) => unknown },
): void {
  const reg = createZodToolRegistrar(createRegisterSimpleTool(server));

  /**
   * Every MUTATING kubernetes tool goes through here. Outside the gateway this adds the
   * consent gate, the write-scope allow-list, the mutation budget and the audit record; inside
   * the gateway it is a pass-through, because executor.ts (I2) is the gate there.
   */
  const registerWriteTool = createWriteToolRegistrar(server, {
    connector: "kubernetes",
    scopeEnv: "NIMBUS_MCP_KUBERNETES_WRITE_SCOPE",
    scopeKinds: ["namespace"],
  });

  reg(
    "k8s_pod_list",
    "List pods in a namespace (default namespace: default).",
    optionalNamespaceSchema,
    (p) => k8sListNamespacedResource(p, "pods"),
  );

  reg(
    "k8s_deployment_get",
    "Get one deployment's state: {name, namespace, replicas, readyReplicas, generation, observedGeneration, restartedAt, images}. The before-state of a restart or a scale.",
    z.object({ namespace: cliArg.optional(), name: cliArg }),
    async (p) => {
      let data: unknown;
      try {
        // kubectlJson builds on kubectlBase(), so the configured KUBE_CONTEXT applies as it does
        // to every other call here.
        data = await kubectlJson(["get", "deployment", p.name, "-n", p.namespace ?? "default"]);
      } catch (e) {
        // Exit code of a missing object is not documented, so NotFound is read from the message.
        if (e instanceof Error && isKubectlNotFound(e.message)) {
          throw new Error("deployment not found", { cause: e });
        }
        throw e;
      }
      return jsonResult(projectDeployment(data));
    },
  );

  reg("k8s_deployment_list", "List deployments in a namespace.", optionalNamespaceSchema, (p) =>
    k8sListNamespacedResource(p, "deployments"),
  );

  reg("k8s_event_list", "List events in a namespace.", optionalNamespaceSchema, (p) =>
    k8sListNamespacedResource(p, "events"),
  );

  registerWriteTool(
    "k8s_rollout_restart",
    {
      mutates: "kubernetes.rollout.restart",
      recoverable: true,
      scopeTargetOf: (p) => ({ kind: "namespace", value: p.namespace ?? "default" }),
    },
    "Restart a rollout (e.g. deployment).",
    z.object({
      namespace: cliArg.optional(),
      resourceType: cliArg,
      name: cliArg,
    }),
    async (p) => {
      const ns = p.namespace ?? "default";
      const cmd = [...kubectlBase(), "rollout", "restart", p.resourceType, p.name, "-n", ns];
      await withKube((env) => runCliOkThrowing(cmd, env));
      return jsonResult({ ok: true });
    },
  );

  registerWriteTool(
    "k8s_pod_delete",
    {
      mutates: "kubernetes.pod.delete",
      // A deleted pod is not restorable; its identity is all that remains to record — including
      // the namespace the delete defaulted to, without which the record cannot say where it was.
      recoverable: false,
      capturePreState: (p) =>
        Promise.resolve({ namespace: p.namespace ?? "default", podName: p.podName }),
      scopeTargetOf: (p) => ({ kind: "namespace", value: p.namespace ?? "default" }),
    },
    "Delete a pod.",
    z.object({
      namespace: cliArg.optional(),
      podName: cliArg,
    }),
    async (p) => {
      const ns = p.namespace ?? "default";
      const cmd = [...kubectlBase(), "delete", "pod", p.podName, "-n", ns];
      await withKube((env) => runCliOkThrowing(cmd, env));
      return jsonResult({ ok: true });
    },
  );

  registerWriteTool(
    "k8s_deployment_scale",
    {
      mutates: "kubernetes.deployment.scale",
      recoverable: true,
      scopeTargetOf: (p) => ({ kind: "namespace", value: p.namespace ?? "default" }),
    },
    "Scale a deployment.",
    z.object({
      namespace: cliArg.optional(),
      deploymentName: cliArg,
      replicas: z.number().int().min(0),
    }),
    async (p) => {
      const ns = p.namespace ?? "default";
      const cmd = [
        ...kubectlBase(),
        "scale",
        "deployment",
        p.deploymentName,
        `-n`,
        ns,
        `--replicas=${String(p.replicas)}`,
      ];
      await withKube((env) => runCliOkThrowing(cmd, env));
      return jsonResult({ ok: true });
    },
  );
}
