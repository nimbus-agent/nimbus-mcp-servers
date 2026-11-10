/**
 * manifest-diff: the plan's diff, computed here from two `kubectl ... -o json` replies instead of
 * by `kubectl diff` (which needs a `diff` program: Windows has none, and one named by the
 * environment is not one to trust with the text an owner approves). Pure: no process, no file.
 *
 *   - {@link unpackKubeJson} reads a kubectl reply (nothing, a bare object, or a List) into a map
 *     keyed `<resource prefix>/<metadata.name>`, failing closed on anything it cannot key.
 *   - {@link normaliseForDiff} drops the fields the API server changes on its own and renders one
 *     object as indented JSON, keys sorted, one value per line.
 *   - {@link planDiff} diffs the planned (server-side dry run) side against the live side, per
 *     object in code-unit order, with `shared/line-diff.ts`.
 */

import { createHash } from "node:crypto";
import { LineDiffTooLargeError, unifiedLineDiff } from "../../../shared/line-diff.ts";

/** The `kubectl ... -o name` resource prefix of each allowlisted kind. */
export const RESOURCE_PREFIX: Readonly<Record<string, string>> = {
  ConfigMap: "configmap",
  Secret: "secret",
  Service: "service",
  Pod: "pod",
  ServiceAccount: "serviceaccount",
  PersistentVolumeClaim: "persistentvolumeclaim",
  Deployment: "deployment.apps",
  StatefulSet: "statefulset.apps",
  DaemonSet: "daemonset.apps",
  ReplicaSet: "replicaset.apps",
  Job: "job.batch",
  CronJob: "cronjob.batch",
  Ingress: "ingress.networking.k8s.io",
  NetworkPolicy: "networkpolicy.networking.k8s.io",
  Role: "role.rbac.authorization.k8s.io",
  RoleBinding: "rolebinding.rbac.authorization.k8s.io",
  HorizontalPodAutoscaler: "horizontalpodautoscaler.autoscaling",
  PodDisruptionBudget: "poddisruptionbudget.policy",
};

/** What a live object is rendered as when it does not exist yet. */
export const ABSENT_LIVE = "(absent: will be created)";

/** Domain separator of {@link diffSha256}. */
export const DIFF_HASH_DOMAIN = "nimbus-k8s-diff-v1";

/** sha256 (hex) of the domain, a newline and the diff text, as UTF-8. */
export function diffSha256(diff: string): string {
  return createHash("sha256").update(`${DIFF_HASH_DOMAIN}\n${diff}`, "utf8").digest("hex");
}

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Order by UTF-16 code unit, the same on every machine (not `localeCompare`: collation can tie). */
export function compareCodeUnits(a: string, b: string): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

/**
 * The objects in a kubectl `-o json` reply, keyed `<resource prefix>/<metadata.name>`, in the
 * order kubectl gave them. Nothing printed (`null` or an empty string) is no objects; a
 * `{kind: "List", items}` is its items; any other object is itself. An item without a string kind
 * and a string name, of a kind outside {@link RESOURCE_PREFIX}, or a second one with a key already
 * seen, throws: a reply that cannot be keyed is never half-trusted.
 */
export function unpackKubeJson(data: unknown): Map<string, Obj> {
  const out = new Map<string, Obj>();
  if (data === null || data === undefined || data === "") return out;
  if (!isObj(data)) throw new Error("kubectl returned JSON that is not an object");
  let items: unknown[];
  if (data["kind"] === "List") {
    if (!Array.isArray(data["items"])) throw new Error("kubectl returned a List without items");
    items = data["items"] as unknown[];
  } else {
    items = [data];
  }
  for (const item of items) {
    if (!isObj(item)) throw new Error("kubectl returned an item that is not an object");
    const kind = item["kind"];
    const meta = item["metadata"];
    const name = isObj(meta) ? meta["name"] : undefined;
    if (typeof kind !== "string" || kind === "" || typeof name !== "string" || name === "") {
      throw new Error("kubectl returned an object without a kind and a name");
    }
    const prefix = Object.hasOwn(RESOURCE_PREFIX, kind) ? RESOURCE_PREFIX[kind] : undefined;
    if (prefix === undefined) {
      throw new Error(`kubectl returned a ${kind}, which is not on the allowlist`);
    }
    const key = `${prefix}/${name}`;
    if (out.has(key)) throw new Error(`kubectl returned ${key} twice`);
    out.set(key, item);
  }
  return out;
}

const DROPPED_METADATA = [
  "managedFields",
  "resourceVersion",
  "uid",
  "generation",
  "creationTimestamp",
  "selfLink",
] as const;
const LAST_APPLIED = "kubectl.kubernetes.io/last-applied-configuration";

/**
 * The name the ServiceAccount admission plugin gives the token volume it injects into a Pod
 * (`kube-api-access-` and five random characters). A new Pod's dry run gets a fresh one each time,
 * so it would change the diff hash between the plan and the apply's re-plan.
 */
const GENERATED_TOKEN_VOLUME = /^kube-api-access-[a-z0-9]{5}$/;

/** True for a volume the ServiceAccount admission plugin generated: the name and a projected token. */
function isGeneratedTokenVolume(v: unknown): boolean {
  if (!isObj(v) || typeof v["name"] !== "string" || !GENERATED_TOKEN_VOLUME.test(v["name"])) {
    return false;
  }
  const projected = v["projected"];
  const sources = isObj(projected) ? projected["sources"] : undefined;
  return Array.isArray(sources) && sources.some((s) => isObj(s) && isObj(s["serviceAccountToken"]));
}

/** What a Job label value derived from the Job's own (generated) uid is rendered as. */
export const GENERATED_JOB_UID = "(generated by the cluster)";

/**
 * In a Job, every value of `spec.selector.matchLabels` and `spec.template.metadata.labels` equal
 * to the Job's own `metadata.uid` becomes {@link GENERATED_JOB_UID}. The API server writes the
 * uid into the automatic selector and its template labels (`batch.kubernetes.io/controller-uid`,
 * `controller-uid`), and a new Job's dry run gets a fresh uid each time, which would change the
 * diff hash between the plan and the apply's re-plan. A value the user wrote cannot equal a uid
 * the server had not generated yet, so it is kept.
 */
function maskGeneratedJobUid(copy: Obj): void {
  const meta = copy["metadata"];
  const uid = isObj(meta) ? meta["uid"] : undefined;
  const spec = copy["spec"];
  if (typeof uid !== "string" || uid === "" || !isObj(spec)) return;
  const selector = spec["selector"];
  const template = spec["template"];
  const templateMeta = isObj(template) ? template["metadata"] : undefined;
  const maps = [
    isObj(selector) ? selector["matchLabels"] : undefined,
    isObj(templateMeta) ? templateMeta["labels"] : undefined,
  ];
  for (const labels of maps) {
    if (!isObj(labels)) continue;
    for (const key of Object.keys(labels)) {
      if (labels[key] === uid) labels[key] = GENERATED_JOB_UID;
    }
  }
}

/** Drops, from a Pod's spec, the generated token volume and every container's mount of it. */
function dropGeneratedTokenVolume(spec: Obj): void {
  const volumes = spec["volumes"];
  if (!Array.isArray(volumes)) return;
  const generated = new Set(
    volumes.filter(isGeneratedTokenVolume).map((v) => (v as Obj)["name"] as string),
  );
  if (generated.size === 0) return;
  const kept = volumes.filter((v) => !isGeneratedTokenVolume(v));
  if (kept.length === 0) delete spec["volumes"];
  else spec["volumes"] = kept;
  for (const containers of [
    spec["containers"],
    spec["initContainers"],
    spec["ephemeralContainers"],
  ]) {
    if (!Array.isArray(containers)) continue;
    for (const c of containers) {
      if (!isObj(c) || !Array.isArray(c["volumeMounts"])) continue;
      const mounts = (c["volumeMounts"] as unknown[]).filter(
        (m) => !(isObj(m) && typeof m["name"] === "string" && generated.has(m["name"])),
      );
      if (mounts.length === 0) delete c["volumeMounts"];
      else c["volumeMounts"] = mounts;
    }
  }
}

/** `v` with every object's keys in code-unit order (arrays keep their order). */
function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (!isObj(v)) return v;
  return Object.fromEntries(
    Object.keys(v)
      .sort(compareCodeUnits)
      .map((k) => [k, sortKeys(v[k])]),
  );
}

/**
 * One object as the lines that are diffed. Dropped, and nothing else: `metadata.managedFields`,
 * `resourceVersion`, `uid`, `generation`, `creationTimestamp`, `selfLink`, the top-level `status`,
 * and the annotation `kubectl.kubernetes.io/last-applied-configuration` (an `annotations` map that
 * held only that one is then empty and is dropped with it), and, in a Pod, the token volume the
 * ServiceAccount admission plugin generated (a `kube-api-access-xxxxx` projected
 * `serviceAccountToken` volume) with every container's mount of it; in a Job, a selector or
 * template label value equal to the Job's own uid is masked as {@link GENERATED_JOB_UID}. Keys sorted by code unit, rendered as
 * 2-space-indented JSON, so a scalar is a line of its own. The input is not changed.
 */
export function normaliseForDiff(obj: Obj): string[] {
  const copy = structuredClone(obj);
  delete copy["status"];
  if (copy["kind"] === "Pod" && isObj(copy["spec"])) dropGeneratedTokenVolume(copy["spec"]);
  if (copy["kind"] === "Job") maskGeneratedJobUid(copy);
  const meta = copy["metadata"];
  if (isObj(meta)) {
    for (const key of DROPPED_METADATA) delete meta[key];
    const ann = meta["annotations"];
    if (isObj(ann) && Object.hasOwn(ann, LAST_APPLIED)) {
      delete ann[LAST_APPLIED];
      if (Object.keys(ann).length === 0) delete meta["annotations"];
    }
  }
  return JSON.stringify(sortKeys(copy), null, 2).split("\n");
}

/**
 * The plan's diff: per object, in code-unit order of `<prefix>/<name>`, a unified diff of the live
 * object (or {@link ABSENT_LIVE}) against the planned one, headers `--- live <key>` and
 * `+++ planned <key>`; an object that does not differ adds nothing. "" means no differences.
 * Throws {@link LineDiffTooLargeError} when one object's edit script is past the diff bound.
 */
export function planDiff(
  planned: ReadonlyMap<string, Obj>,
  live: ReadonlyMap<string, Obj>,
): string {
  let out = "";
  for (const key of [...planned.keys()].sort(compareCodeUnits)) {
    const plan = planned.get(key);
    if (plan === undefined) continue;
    const was = live.get(key);
    out += unifiedLineDiff(
      was === undefined ? [ABSENT_LIVE] : normaliseForDiff(was),
      normaliseForDiff(plan),
      {
        fromLabel: `live ${key}`,
        toLabel: `planned ${key}`,
      },
    );
  }
  return out;
}

export { LineDiffTooLargeError };
