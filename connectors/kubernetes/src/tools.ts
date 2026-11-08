import { createHash, timingSafeEqual } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { cliArg } from "../../../shared/cli-json-kit.ts";
import type { ConsentServer } from "../../../shared/consent-kit.ts";
import {
  createPrepareToolRegistrar,
  createWriteToolRegistrar,
} from "../../../shared/consent-kit.ts";
import { isKubectlNotFound, projectDeployment } from "../../../shared/k8s-deployment-view.ts";
import {
  createRegisterSimpleTool,
  createZodToolRegistrar,
  mcpJsonResult as jsonResult,
} from "../../../shared/mcp-tool-kit.ts";
import { withPrivateKubeconfig } from "../../../shared/private-kubeconfig.ts";
import { withScratchDir } from "../../../shared/private-scratch.ts";
import { runCliCode, runCliJsonThrowing, runCliOkThrowing } from "../../../shared/run-cli-json.ts";
import { type ScannedObject, scanNamespacedManifest } from "./manifest-scan.ts";

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

/** A manifest may be at most this many UTF-8 bytes (the schema's character cap is a floor of it). */
const MANIFEST_MAX_BYTES = 262_144;
/** The diff in a plan reply; the owner approves what the preview shows, so a bigger one is refused. */
const DIFF_MAX_BYTES = 65_536;
/** The whole plan reply, which the gateway refuses above this size. */
const PLAN_REPLY_MAX_BYTES = 262_144;
/** Domain separator of the plan hash: sha256 of this, a newline, the namespace, a newline, the manifest. */
const PLAN_HASH_DOMAIN = "nimbus-k8s-manifest-v1";
const MISMATCH = "manifest does not match the approved hash";

interface ManifestInput {
  readonly namespace: string;
  readonly manifest: string;
}

/**
 * The checks every manifest tool makes before it touches a file or a process, in this order: size
 * in UTF-8 bytes, the namespaced-subset scan (manifest-scan.ts), and the hash of the exact bytes
 * kubectl will be handed. Throws a fixed message.
 */
function checkedManifest(p: ManifestInput): {
  bytes: Buffer;
  sha256: string;
  scanned: ScannedObject[];
} {
  const bytes = Buffer.from(p.manifest, "utf8");
  if (bytes.length > MANIFEST_MAX_BYTES) {
    throw new Error(`manifest is larger than ${String(MANIFEST_MAX_BYTES)} bytes`);
  }
  const scanned = scanNamespacedManifest(p.manifest, p.namespace);
  // The hash binds the namespace to the manifest, so an approved plan for one namespace cannot be
  // replayed against another. The kube CONTEXT is owner environment (KUBE_CONTEXT), not caller
  // input, and is deliberately not part of it.
  const hashed = [PLAN_HASH_DOMAIN, p.namespace, p.manifest].join("\n");
  const sha256 = createHash("sha256").update(hashed, "utf8").digest("hex");
  return { bytes, sha256, scanned };
}

/** {@link checkedManifest}, then the apply's own check: the manifest must hash to what was approved. */
function approvedManifest(p: ManifestInput & { readonly planSha256: string }) {
  const checked = checkedManifest(p);
  const want = Buffer.from(p.planSha256, "hex");
  const have = Buffer.from(checked.sha256, "hex");
  // Equal length is checked first: timingSafeEqual throws on unequal buffers. The schema pins 64 hex.
  if (want.length !== have.length || !timingSafeEqual(want, have)) {
    throw new Error(MISMATCH);
  }
  return checked;
}

function refusalOf(check: () => unknown): string | undefined {
  try {
    check();
    return undefined;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

/**
 * kubectl's failure as an error. A Secret in the manifest means kubectl's stderr may quote its
 * data (an invalid value is often echoed), so the snippet is withheld whenever one is present.
 */
function kubectlFailure(
  label: string,
  code: number,
  stderr: string,
  scanned: readonly ScannedObject[],
): Error {
  const detail = scanned.some((o) => o.kind === "Secret")
    ? "(stderr withheld: the manifest holds a Secret)"
    : stderr.slice(0, 500);
  return new Error(`${label} exited ${String(code)}: ${detail}`);
}

/** What a plan's `diff` holds in place of kubectl's when the manifest holds a Secret. */
export const SECRET_DIFF_WITHHELD = "(diff withheld: the manifest holds a Secret)";

/** The `kubectl ... -o name` resource prefix of each allowlisted kind. */
const RESOURCE_PREFIX: Readonly<Record<string, string>> = {
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

/** The sorted `<prefix>/<name>` list the scan expects kubectl to report. */
function expectedNames(scanned: readonly ScannedObject[]): string[] {
  return scanned.map((o) => `${RESOURCE_PREFIX[o.kind] ?? o.kind}/${o.name}`).sort();
}

/**
 * Defence in depth behind the scanner: what kubectl itself reports (`-o name`) must be, as a
 * multiset, exactly what the scan read. A document kubectl reads differently (a List flattened into
 * its items, a kind the scan mis-paired) shows up here as a different set, before the diff and
 * before the real apply. Names only, so the message is safe to show.
 */
function assertSameObjects(
  reported: readonly string[],
  scanned: readonly ScannedObject[],
  when: string,
): void {
  const have = [...reported].sort();
  const want = expectedNames(scanned);
  if (have.length !== want.length || have.some((n, i) => n !== want[i])) {
    throw new Error(
      `kubectl ${when} reported different objects than the manifest scan (kubectl: ${have.join(", ")}; scan: ${want.join(", ")})`,
    );
  }
}

/** Write the manifest into the call's private scratch directory: exclusive create, owner-only. */
async function writeManifestFile(dir: string, bytes: Buffer): Promise<string> {
  const file = join(dir, "manifest.yaml");
  await writeFile(file, bytes, { flag: "wx", mode: 0o600 });
  return file;
}

/** `kubectl apply --server-side --dry-run=server -o name`, cross-checked against the scan. */
async function serverDryRun(
  kube: { readonly KUBECONFIG: string },
  ns: string,
  file: string,
  scanned: readonly ScannedObject[],
): Promise<string[]> {
  const dry = await runCliCode(
    [
      ...kubectlBase(),
      "apply",
      "--server-side",
      "--dry-run=server",
      "--field-manager=nimbus",
      "-n",
      ns,
      "-f",
      file,
      "-o",
      "name",
    ],
    kube,
  );
  if (dry.code !== 0) throw kubectlFailure("kubectl", dry.code, dry.stderr, scanned);
  const objects = objectLines(dry.stdout);
  assertSameObjects(objects, scanned, "dry run");
  return objects;
}

function objectLines(stdout: string): string[] {
  return stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "");
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
  "k8s_manifest_plan",
  "k8s_manifest_apply",
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

  /**
   * Prepare tools (shared/prepare-tool-ids.ts) read the state a write is bound to, for the gateway
   * to call BEFORE the write's approval prompt; they are neither reads nor writes to the kit.
   */
  const registerPrepareTool = createPrepareToolRegistrar(server, {
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

  registerPrepareTool(
    "k8s_manifest_plan",
    { scopeTargetOf: (p) => ({ kind: "namespace", value: p.namespace }) },
    "Plan a k8s_manifest_apply: scan the manifest (namespaced kinds from an allowlist only, in the given namespace), then ask the API server for a server-side dry run and a server-side diff. Returns {planSha256, namespace, objects, scanned, diff, hasDifferences}; the apply must be given the same namespace, manifest and planSha256. Changes nothing.",
    z.object({ namespace: cliArg, manifest: z.string().min(1).max(MANIFEST_MAX_BYTES) }),
    async (p) => {
      const { bytes, sha256, scanned } = checkedManifest(p);
      const ns = p.namespace;
      const reply = await withScratchDir("nimbus-k8s-", async (dir) => {
        const file = await writeManifestFile(dir, bytes);
        return withKube(async (kube) => {
          // The dry run: the API server validates and admits the manifest and names each object,
          // and the names must be the ones the scan read (see assertSameObjects).
          const objects = await serverDryRun(kube, ns, file, scanned);

          // kubectl diff runs the program KUBECTL_EXTERNAL_DIFF names (default `diff -u -N`). The
          // variable is removed from the child whatever the owner's shell sets, so the diff is
          // never produced by an arbitrary program. TMPDIR/TMP/TEMP point kubectl's own temp files
          // (Go reads TMP and TEMP on Windows) into this call's private directory. Exit codes:
          // https://kubernetes.io/docs/reference/kubectl/generated/kubectl_diff/ (0 no
          // differences, 1 differences, >1 error). --force-conflicts is never passed.
          const diff = await runCliCode(
            [
              ...kubectlBase(),
              "diff",
              "--server-side",
              "--field-manager=nimbus",
              "-n",
              ns,
              "-f",
              file,
            ],
            {
              KUBECONFIG: kube.KUBECONFIG,
              KUBECTL_EXTERNAL_DIFF: undefined,
              TMPDIR: dir,
              TMP: dir,
              TEMP: dir,
            },
          );
          if (diff.code !== 0 && diff.code !== 1) {
            throw kubectlFailure("kubectl diff", diff.code, diff.stderr, scanned);
          }
          if (Buffer.byteLength(diff.stdout, "utf8") > DIFF_MAX_BYTES) {
            throw new Error(`diff too large (over ${String(DIFF_MAX_BYTES)} bytes)`);
          }
          // kubectl masks a Secret's `data`, but the diff's context lines can still carry its
          // plaintext (a `last-applied-configuration` annotation, `stringData`), so with a Secret
          // in the manifest only the fact of a difference is returned, never the body.
          const holdsSecret = scanned.some((o) => o.kind === "Secret");
          return {
            planSha256: sha256,
            namespace: ns,
            objects,
            scanned,
            diff: holdsSecret ? SECRET_DIFF_WITHHELD : diff.stdout,
            hasDifferences: diff.code === 1,
          };
        });
      });
      if (Buffer.byteLength(JSON.stringify(reply), "utf8") > PLAN_REPLY_MAX_BYTES) {
        throw new Error("plan reply too large");
      }
      return jsonResult(reply);
    },
  );

  registerWriteTool(
    "k8s_manifest_apply",
    {
      mutates: "kubernetes.manifest.apply",
      // An applied manifest is not undone by this tool; the objects it names are all that remain.
      recoverable: false,
      capturePreState: (p) =>
        Promise.resolve({
          namespace: p.namespace,
          planSha256: p.planSha256,
          objects: checkedManifest(p).scanned,
        }),
      scopeTargetOf: (p) => ({ kind: "namespace", value: p.namespace }),
      // Standalone only: a manifest no consent could make safe is refused before any prompt. The
      // handler repeats the same checks, because gateway mode registers the raw handler.
      refuseBefore: (p) => refusalOf(() => approvedManifest(p)),
    },
    "Apply a manifest with a server-side apply, in the given namespace. The namespace and manifest must be the ones k8s_manifest_plan planned (planSha256) and the manifest must hold namespaced objects of allowlisted kinds only. Runs a server-side dry run first and applies only if kubectl reports the objects the scan read.",
    z.object({
      namespace: cliArg,
      manifest: z.string().min(1).max(MANIFEST_MAX_BYTES),
      planSha256: z.string().regex(/^[0-9a-f]{64}$/),
    }),
    async (p) => {
      const { bytes, scanned } = approvedManifest(p);
      return withScratchDir("nimbus-k8s-", async (dir) => {
        const file = await writeManifestFile(dir, bytes);
        return withKube(async (kube) => {
          // Dry run and cross-check FIRST, so an object kubectl would apply that the scan did not
          // read stops the call before anything changes.
          await serverDryRun(kube, p.namespace, file, scanned);
          // The file the real apply reads must still hold the approved bytes: the dry run was a
          // child process with the same file, and on Windows the 0600 mode is not enforced.
          if (!bytes.equals(await readFile(file))) {
            throw new Error("the manifest file changed before the apply");
          }
          const applied = await runCliCode(
            [
              ...kubectlBase(),
              "apply",
              "--server-side",
              "--field-manager=nimbus",
              "-n",
              p.namespace,
              "-f",
              file,
              "-o",
              "name",
            ],
            kube,
          );
          if (applied.code !== 0) {
            throw kubectlFailure("kubectl", applied.code, applied.stderr, scanned);
          }
          const objects = objectLines(applied.stdout);
          // After the fact: the objects are already applied, so this is reported, not prevented.
          assertSameObjects(objects, scanned, "applied and");
          return jsonResult({ ok: true, status: "applied", objects });
        });
      });
    },
  );
}
