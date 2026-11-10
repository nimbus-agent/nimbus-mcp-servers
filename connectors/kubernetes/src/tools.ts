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
import {
  compareCodeUnits,
  diffSha256,
  planDiff,
  RESOURCE_PREFIX,
  unpackKubeJson,
} from "./manifest-diff.ts";
import { type ScannedObject, scanNamespacedManifest } from "./manifest-scan.ts";

/** `kubectl --context <ctx>`: every call names its context, none relies on the kubeconfig's current one. */
function kubectlBase(context: string): string[] {
  return ["kubectl", "--context", context];
}

const CONTEXT_MISMATCH = "context does not match the configured context";

/**
 * The context every call of this process works against: `KUBE_CONTEXT` if the owner set it, else
 * what `kubectl config current-context` prints for the call's private kubeconfig (never a
 * hand-parse of the file). Fails closed: a kubectl error, no output, or a value that is not a plain
 * argument is an error, so no call ever falls back to some other context.
 */
async function effectiveContext(kube: { readonly KUBECONFIG: string }): Promise<string> {
  let ctx = process.env["KUBE_CONTEXT"]?.trim();
  if (ctx === undefined || ctx === "") {
    const r = await runCliCode(["kubectl", "config", "current-context"], kube);
    if (r.code !== 0) {
      throw new Error(`could not determine the kubectl context: kubectl exited ${String(r.code)}`);
    }
    ctx = r.stdout.trim();
    if (ctx === "") {
      throw new Error("could not determine the kubectl context: kubectl printed none");
    }
  }
  if (!cliArg.safeParse(ctx).success) {
    throw new Error("the configured kubectl context is not a plain value");
  }
  return ctx;
}

/**
 * Run `body` on a private kubeconfig copy (shared/private-kubeconfig.ts: one tool call, one copy, so
 * a call can neither change the owner's file nor race another) with the effective context. A
 * `given` context that is not that context throws before `body` runs.
 */
function withKube<T>(
  given: string | undefined,
  body: (kube: { readonly KUBECONFIG: string }, context: string) => Promise<T>,
): Promise<T> {
  return withPrivateKubeconfig({ source: process.env["KUBECONFIG"] ?? "" }, async (kube) => {
    const context = await effectiveContext(kube);
    if (given !== undefined && given !== context) throw new Error(CONTEXT_MISMATCH);
    return body(kube, context);
  });
}

function kubectlJson(rest: string[], given: string | undefined): Promise<unknown> {
  return withKube(given, (env, context) =>
    runCliJsonThrowing([...kubectlBase(context), ...rest, "-o", "json"], env),
  );
}

/** A manifest may be at most this many UTF-8 bytes (the schema's character cap is a floor of it). */
const MANIFEST_MAX_BYTES = 262_144;
/** The diff in a plan reply; the owner approves what the preview shows, so a bigger one is refused. */
const DIFF_MAX_BYTES = 65_536;
/** The whole plan reply, which the gateway refuses above this size. */
const PLAN_REPLY_MAX_BYTES = 262_144;
/** Domain separator of the plan hash (see {@link planHash}). */
const PLAN_HASH_DOMAIN = "nimbus-k8s-manifest-v2";
const MISMATCH = "manifest does not match the approved hash";
const CLUSTER_CHANGED = "the cluster changed since the plan was approved";

interface ManifestInput {
  readonly namespace: string;
  readonly manifest: string;
}

/**
 * The checks every manifest tool makes before it touches a file or a process, in this order: size
 * in UTF-8 bytes, then the namespaced-subset scan (manifest-scan.ts). Throws a fixed message.
 */
function checkedManifest(p: ManifestInput): { bytes: Buffer; scanned: ScannedObject[] } {
  const bytes = Buffer.from(p.manifest, "utf8");
  if (bytes.length > MANIFEST_MAX_BYTES) {
    throw new Error(`manifest is larger than ${String(MANIFEST_MAX_BYTES)} bytes`);
  }
  return { bytes, scanned: scanNamespacedManifest(p.manifest, p.namespace) };
}

/**
 * The plan hash (v2): sha256 of the domain, the EFFECTIVE context, the namespace and the exact
 * manifest text, newline-separated. The context and namespace are in it, so an approved plan
 * cannot be replayed on another cluster or in another namespace. v1 (no context) is retired.
 */
export function planHash(context: string, namespace: string, manifest: string): string {
  return createHash("sha256")
    .update([PLAN_HASH_DOMAIN, context, namespace, manifest].join("\n"), "utf8")
    .digest("hex");
}

/** Constant-time equality of two lowercase-hex digests (equal length is checked first). */
function sameHex(a: string, b: string): boolean {
  const want = Buffer.from(a, "hex");
  const have = Buffer.from(b, "hex");
  return want.length === have.length && timingSafeEqual(want, have);
}

/** The apply's own check: the manifest must hash, under this context, to what was approved. */
function assertApprovedHash(context: string, p: ManifestInput & { readonly planSha256: string }) {
  if (!sameHex(p.planSha256, planHash(context, p.namespace, p.manifest))) {
    throw new Error(MISMATCH);
  }
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

/** The sorted `<prefix>/<name>` list the scan expects kubectl to report. */
function expectedNames(scanned: readonly ScannedObject[]): string[] {
  return scanned
    .map((o) => `${RESOURCE_PREFIX[o.kind] ?? o.kind}/${o.name}`)
    .sort(compareCodeUnits);
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
  const have = [...reported].sort(compareCodeUnits);
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

/** Parse a kubectl `-o json` reply; an unparsable one is an error that never echoes the text (it may hold a Secret). */
function parseKubeReply(stdout: string, what: string): unknown {
  const trimmed = stdout.trim();
  if (trimmed === "") return null;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    throw new Error(`kubectl ${what} returned invalid JSON`);
  }
}

/** What the plan computes, and what the apply recomputes to compare. */
interface Computed {
  readonly objects: string[];
  /** The diff as the reply shows it (withheld when the manifest holds a Secret). */
  readonly diff: string;
  readonly hasDifferences: boolean;
  readonly diffSha256: string;
}

/**
 * The plan: a server-side dry run (`-o json`, the objects as the API server would admit them,
 * cross-checked against the scan), one `kubectl get` of the same objects as they are now
 * (`--ignore-not-found`), and the built-in diff of the two (manifest-diff.ts). Changes nothing.
 */
async function computePlan(
  kube: { readonly KUBECONFIG: string },
  context: string,
  ns: string,
  file: string,
  scanned: readonly ScannedObject[],
): Promise<Computed> {
  const base = kubectlBase(context);
  const dry = await runCliCode(
    [
      ...base,
      "apply",
      "--server-side",
      "--dry-run=server",
      "--field-manager=nimbus",
      "-n",
      ns,
      "-f",
      file,
      "-o",
      "json",
    ],
    kube,
  );
  if (dry.code !== 0) throw kubectlFailure("kubectl", dry.code, dry.stderr, scanned);
  const planned = unpackKubeJson(parseKubeReply(dry.stdout, "dry run"));
  const objects = [...planned.keys()];
  assertSameObjects(objects, scanned, "dry run");

  const names = [...new Set(expectedNames(scanned))];
  const get = await runCliCode(
    [...base, "get", ...names, "-n", ns, "-o", "json", "--ignore-not-found"],
    kube,
  );
  if (get.code !== 0) throw kubectlFailure("kubectl get", get.code, get.stderr, scanned);
  const live = unpackKubeJson(parseKubeReply(get.stdout, "get"));

  const full = planDiff(planned, live);
  if (Buffer.byteLength(full, "utf8") > DIFF_MAX_BYTES) {
    throw new Error(`diff too large (over ${String(DIFF_MAX_BYTES)} bytes)`);
  }
  // A Secret's plaintext can sit in either side of the diff, so with a Secret in the manifest only
  // the fact of a difference is returned, never the body. (Stated bound: the diff hash then covers
  // the withheld text, so the apply's re-diff cannot see a Secret's change.)
  const holdsSecret = scanned.some((o) => o.kind === "Secret");
  const diff = holdsSecret ? SECRET_DIFF_WITHHELD : full;
  return { objects, diff, hasDifferences: full !== "", diffSha256: diffSha256(diff) };
}

function objectLines(stdout: string): string[] {
  return stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "");
}

/** Reads: `context` is optional; when given it must be the effective one. */
const readSchema = z.object({ context: cliArg.optional(), namespace: cliArg.optional() });

async function k8sListNamespacedResource(
  p: { context?: string | undefined; namespace?: string | undefined },
  resource: string,
) {
  const data = await kubectlJson(["get", resource, "-n", p.namespace ?? "default"], p.context);
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
    "List pods in a namespace (default namespace: default). `context` is optional; when given it must be the configured context (`KUBE_CONTEXT`, else the kubeconfig's current one).",
    readSchema,
    (p) => k8sListNamespacedResource(p, "pods"),
  );

  reg(
    "k8s_deployment_get",
    "Get one deployment's state: {name, namespace, replicas, readyReplicas, generation, observedGeneration, restartedAt, images}. The before-state of a restart or a scale. `context` is optional; when given it must be the configured context.",
    z.object({ context: cliArg.optional(), namespace: cliArg.optional(), name: cliArg }),
    async (p) => {
      let data: unknown;
      try {
        data = await kubectlJson(
          ["get", "deployment", p.name, "-n", p.namespace ?? "default"],
          p.context,
        );
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

  reg(
    "k8s_deployment_list",
    "List deployments in a namespace. `context` is optional; when given it must be the configured context.",
    readSchema,
    (p) => k8sListNamespacedResource(p, "deployments"),
  );

  reg(
    "k8s_event_list",
    "List events in a namespace. `context` is optional; when given it must be the configured context.",
    readSchema,
    (p) => k8sListNamespacedResource(p, "events"),
  );

  registerWriteTool(
    "k8s_rollout_restart",
    {
      mutates: "kubernetes.rollout.restart",
      recoverable: true,
      scopeTargetOf: (p) => ({ kind: "namespace", value: p.namespace }),
    },
    "Restart a rollout (e.g. deployment). `context` and `namespace` are required; `context` must be the configured context (`KUBE_CONTEXT`, else the kubeconfig's current one).",
    z.object({
      context: cliArg,
      namespace: cliArg,
      resourceType: cliArg,
      name: cliArg,
    }),
    async (p) => {
      await withKube(p.context, (env, context) =>
        runCliOkThrowing(
          [
            ...kubectlBase(context),
            "rollout",
            "restart",
            p.resourceType,
            p.name,
            "-n",
            p.namespace,
          ],
          env,
        ),
      );
      return jsonResult({ ok: true });
    },
  );

  registerWriteTool(
    "k8s_pod_delete",
    {
      mutates: "kubernetes.pod.delete",
      // A deleted pod is not restorable; its identity is all that remains to record.
      recoverable: false,
      capturePreState: (p) =>
        Promise.resolve({ context: p.context, namespace: p.namespace, podName: p.podName }),
      scopeTargetOf: (p) => ({ kind: "namespace", value: p.namespace }),
    },
    "Delete a pod. `context` and `namespace` are required; `context` must be the configured context.",
    z.object({
      context: cliArg,
      namespace: cliArg,
      podName: cliArg,
    }),
    async (p) => {
      await withKube(p.context, (env, context) =>
        runCliOkThrowing(
          [...kubectlBase(context), "delete", "pod", p.podName, "-n", p.namespace],
          env,
        ),
      );
      return jsonResult({ ok: true });
    },
  );

  registerWriteTool(
    "k8s_deployment_scale",
    {
      mutates: "kubernetes.deployment.scale",
      recoverable: true,
      scopeTargetOf: (p) => ({ kind: "namespace", value: p.namespace }),
    },
    "Scale a deployment. `context` and `namespace` are required; `context` must be the configured context.",
    z.object({
      context: cliArg,
      namespace: cliArg,
      deploymentName: cliArg,
      replicas: z.number().int().min(0),
    }),
    async (p) => {
      await withKube(p.context, (env, context) =>
        runCliOkThrowing(
          [
            ...kubectlBase(context),
            "scale",
            "deployment",
            p.deploymentName,
            "-n",
            p.namespace,
            `--replicas=${String(p.replicas)}`,
          ],
          env,
        ),
      );
      return jsonResult({ ok: true });
    },
  );

  registerPrepareTool(
    "k8s_manifest_plan",
    { scopeTargetOf: (p) => ({ kind: "namespace", value: p.namespace }) },
    "Plan a k8s_manifest_apply: scan the manifest (namespaced kinds from an allowlist only, in the given namespace), ask the API server for a server-side dry run, read the same objects as they are now, and diff the two in this connector (no `diff` program). Returns {planSha256, diffSha256, namespace, objects, scanned, diff, hasDifferences}; the apply must be given the same context, namespace, manifest, planSha256 and diffSha256. `context` must be the configured context (`KUBE_CONTEXT`, else the kubeconfig's current one) and is part of planSha256. Changes nothing.",
    z.object({
      context: cliArg,
      namespace: cliArg,
      manifest: z.string().min(1).max(MANIFEST_MAX_BYTES),
    }),
    async (p) => {
      const { bytes, scanned } = checkedManifest(p);
      const reply = await withScratchDir("nimbus-k8s-", async (dir) => {
        const file = await writeManifestFile(dir, bytes);
        return withKube(p.context, async (kube, context) => {
          const plan = await computePlan(kube, context, p.namespace, file, scanned);
          return {
            planSha256: planHash(context, p.namespace, p.manifest),
            diffSha256: plan.diffSha256,
            namespace: p.namespace,
            objects: plan.objects,
            scanned,
            diff: plan.diff,
            hasDifferences: plan.hasDifferences,
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
          context: p.context,
          namespace: p.namespace,
          planSha256: p.planSha256,
          diffSha256: p.diffSha256,
          objects: checkedManifest(p).scanned,
        }),
      scopeTargetOf: (p) => ({ kind: "namespace", value: p.namespace }),
      // Standalone only: a manifest no consent could make safe is refused before any prompt. The
      // handler repeats the same checks, because gateway mode registers the raw handler. The hash
      // needs the effective context, which may take a kubectl call, so it is checked here only when
      // KUBE_CONTEXT names it; the handler always checks it.
      refuseBefore: (p) =>
        refusalOf(() => {
          checkedManifest(p);
          const configured = process.env["KUBE_CONTEXT"]?.trim();
          if (configured === undefined || configured === "") return;
          if (p.context !== configured) throw new Error(CONTEXT_MISMATCH);
          assertApprovedHash(configured, p);
        }),
    },
    "Apply a manifest with a server-side apply, in the given context and namespace. The context, namespace and manifest must be the ones k8s_manifest_plan planned (planSha256), and diffSha256 must be the plan's: the apply first recomputes the plan against the cluster and applies only if the diff is the one that was approved, else it throws 'the cluster changed since the plan was approved' and applies nothing. The manifest must hold namespaced objects of allowlisted kinds only. `context` must be the configured context.",
    z.object({
      context: cliArg,
      namespace: cliArg,
      manifest: z.string().min(1).max(MANIFEST_MAX_BYTES),
      planSha256: z.string().regex(/^[0-9a-f]{64}$/),
      diffSha256: z.string().regex(/^[0-9a-f]{64}$/),
    }),
    async (p) => {
      const { bytes, scanned } = checkedManifest(p);
      return withScratchDir("nimbus-k8s-", async (dir) => {
        const file = await writeManifestFile(dir, bytes);
        return withKube(p.context, async (kube, context) => {
          assertApprovedHash(context, p);
          // The re-diff: exactly the plan's dry run, get and diff, again, now. Any failure of it, or
          // a diff that is not the approved one, means the cluster is not what the owner saw.
          let again: Computed;
          try {
            again = await computePlan(kube, context, p.namespace, file, scanned);
          } catch (e) {
            throw new Error(CLUSTER_CHANGED, { cause: e });
          }
          if (!sameHex(again.diffSha256, p.diffSha256)) throw new Error(CLUSTER_CHANGED);
          // The file the real apply reads must still hold the approved bytes: the re-diff ran
          // child processes on the same file, and on Windows the 0600 mode is not enforced.
          if (!bytes.equals(await readFile(file))) {
            throw new Error("the manifest file changed before the apply");
          }
          const applied = await runCliCode(
            [
              ...kubectlBase(context),
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
