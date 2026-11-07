/**
 * k8s-deployment-view: the one projection of `kubectl get deployment -o json` that the
 * `kubernetes` and `gcp` before-state reads share, so a rollout restart or a scale is previewed
 * from the same fields whichever connector runs it.
 *
 * Field sources: apps/v1 Deployment (https://kubernetes.io/docs/reference/kubernetes-api/workload-resources/deployment-v1/).
 * `status.readyReplicas` is omitted by the API server when zero (the Go field is `omitempty`), so an
 * absent value is reported as 0; `spec.replicas` is reported as given and is absent when the server
 * did not return one. The restart time is the annotation `kubectl rollout restart` sets.
 */

export type DeploymentView = {
  readonly name: string;
  readonly namespace: string;
  readonly replicas?: number;
  readonly readyReplicas: number;
  readonly generation?: number;
  readonly observedGeneration?: number;
  readonly restartedAt?: string;
  readonly images: readonly string[];
};

const RESTARTED_AT = "kubectl.kubernetes.io/restartedAt";

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/** Project a Deployment object; throws when `raw` is not one (no name). */
export function projectDeployment(raw: unknown): DeploymentView {
  if (!isRecord(raw)) throw new Error("deployment not found");
  const meta = isRecord(raw["metadata"]) ? raw["metadata"] : {};
  const spec = isRecord(raw["spec"]) ? raw["spec"] : {};
  const status = isRecord(raw["status"]) ? raw["status"] : {};
  const name = meta["name"];
  if (typeof name !== "string" || name === "") throw new Error("deployment not found");
  const template = isRecord(spec["template"]) ? spec["template"] : {};
  const tmeta = isRecord(template["metadata"]) ? template["metadata"] : {};
  const annotations = isRecord(tmeta["annotations"]) ? tmeta["annotations"] : {};
  const podSpec = isRecord(template["spec"]) ? template["spec"] : {};
  const containers = Array.isArray(podSpec["containers"]) ? podSpec["containers"] : [];
  const images = containers
    .map((c) => (isRecord(c) && typeof c["image"] === "string" ? c["image"] : undefined))
    .filter((i): i is string => i !== undefined);
  const replicas = num(spec["replicas"]);
  const generation = num(meta["generation"]);
  const observedGeneration = num(status["observedGeneration"]);
  const restartedAt = annotations[RESTARTED_AT];
  return {
    name,
    namespace: typeof meta["namespace"] === "string" ? meta["namespace"] : "",
    ...(replicas === undefined ? {} : { replicas }),
    readyReplicas: num(status["readyReplicas"]) ?? 0,
    ...(generation === undefined ? {} : { generation }),
    ...(observedGeneration === undefined ? {} : { observedGeneration }),
    ...(typeof restartedAt === "string" ? { restartedAt } : {}),
    images,
  };
}

/** Whether a kubectl failure message says the object does not exist. */
export function isKubectlNotFound(message: string): boolean {
  return /NotFound|not found/i.test(message);
}
