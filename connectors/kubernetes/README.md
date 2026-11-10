# Kubernetes Connector

## What this is

Nimbus MCP connector for Kubernetes. Indexes and provides context from Kubernetes to the Nimbus agent.

## Install

Bundled with Nimbus — no separate install required.

## Quickstart

```bash
nimbus connector auth kubernetes
nimbus ask "Summarize my recent activity in Kubernetes"
```

## Behaviour notes

- Every `kubectl` call runs on a private copy of the kubeconfig `KUBECONFIG` names, in its own
  directory, removed afterwards. `KUBECONFIG` must name ONE regular file (not a symlink, not a list:
  `:` separates paths on Linux and macOS, `;` on Windows). A kubeconfig whose certificate paths are
  relative will not find them from the copy: use absolute paths or embedded certificate data.
- `k8s_deployment_get {namespace?, name}` returns `{name, namespace, replicas, readyReplicas,
  generation, observedGeneration, restartedAt, images}`, the before-state of a restart or a scale.
  A missing deployment is detected from kubectl's message (`NotFound`), since the exit code for it is
  not documented. Live check: the exit code and message against a real cluster.
- **Context.** Every call names its context. The effective context is `KUBE_CONTEXT` if set, else
  what `kubectl config current-context` prints for the call's private kubeconfig (an error or empty
  output fails the call; the file is never hand-parsed), and it is always passed as `--context`.
  `context` and `namespace` are REQUIRED on `k8s_manifest_plan`, `k8s_manifest_apply`,
  `k8s_rollout_restart`, `k8s_deployment_scale` and `k8s_pod_delete`; `context` is optional on the
  reads (`k8s_pod_list`, `k8s_deployment_get`, `k8s_deployment_list`, `k8s_event_list`). A `context`
  that is not the effective one fails with `context does not match the configured context` before
  any other kubectl call.
- `k8s_manifest_plan {context, namespace, manifest}` and `k8s_manifest_apply {context, namespace,
  manifest, planSha256, diffSha256}` are a pair. The plan is a PREPARE tool (it changes nothing): it
  scans the manifest, asks the API server for `kubectl apply --server-side --dry-run=server
  --field-manager=nimbus -o json` (the objects as they would be admitted) and for
  `kubectl get <resource>/<name>... -o json --ignore-not-found` (the same objects now), and diffs the
  two itself (`src/manifest-diff.ts`, `shared/line-diff.ts`; no `diff` program, so Windows works).
  Both sides drop `metadata.managedFields`, `resourceVersion`, `uid`, `generation`,
  `creationTimestamp`, `selfLink`, `status` and the `kubectl.kubernetes.io/last-applied-configuration`
  annotation (an `annotations` map left empty by that is dropped too), keys sorted by UTF-16 code
  unit, indented JSON one value per line. Per object, sorted by `<resource>/<name>`, a unified diff
  (Myers, 3 context lines, `--- live <resource>/<name>`, `+++ planned <resource>/<name>`, an object
  that does not exist yet shown as `(absent: will be created)`; hunk headers always carry both
  counts). The reply is `{planSha256, diffSha256, namespace, objects, scanned, diff,
  hasDifferences}` (under 256 KiB; a diff over 64 KiB, or one past the diff algorithm's bound, is
  refused, so the owner never approves what the preview cannot show).
- **The hashes.** `planSha256` = sha256 of UTF-8 `"nimbus-k8s-manifest-v2\n" + context + "\n" +
  namespace + "\n" + manifest`, with the EFFECTIVE context, so a plan cannot be replayed on another
  cluster or in another namespace (v1, which had no context, is retired). `diffSha256` = sha256 of
  UTF-8 `"nimbus-k8s-diff-v1\n" + diff`, of the `diff` text exactly as the reply carries it.
- **The apply re-diffs.** It takes the same context, namespace and manifest and BOTH hashes,
  re-runs every check, refuses a different `planSha256` before any process starts when
  `KUBE_CONTEXT` is set (else after the one `kubectl config current-context` call), then recomputes
  the plan (dry run, get, diff) on the same file. A different `diffSha256`, or any failure of that
  recomputation, throws exactly `the cluster changed since the plan was approved` and applies
  nothing; otherwise it runs `kubectl apply --server-side --field-manager=nimbus`. `--force-conflicts`
  is never passed. A manifest is at most 262,144 UTF-8 bytes. In standalone mode the plan needs the
  write scope (`NIMBUS_MCP_KUBERNETES_WRITE_SCOPE=namespace:<ns>`) and is audited as `prepared`.
  Stated bound: server-side apply has no whole-manifest precondition, so the milliseconds between
  the re-diff's `get` and the apply remain open.
- **The manifest scanner** (`src/manifest-scan.ts`) exists because `-n` makes kubectl refuse a
  namespaced object in another namespace but does nothing about a cluster-scoped kind. It is a linear
  reader of a deliberately small YAML subset, not a YAML parser, and it refuses everything it cannot
  read with certainty, so that kubectl's YAML reader (go-yaml, YAML 1.1) can never read a different
  kind or namespace than it did. Accepted: block-style YAML in which every column-0 line is a plain
  `key:` or `key: value`; documents separated by a line that is exactly `---` (a `---` also ends a
  block scalar, as in go-yaml); `apiVersion`, `kind` and `metadata` once each; `metadata` a block
  mapping; the four values it interprets (`kind`, `apiVersion`, `metadata.name`, `metadata.namespace`)
  on one line, as plain or simply quoted scalars with no escapes (a plain name that YAML 1.1 reads as
  a boolean, null or number, such as `yes` or `123`, must be quoted); `metadata.namespace`, if present,
  equal to the argument. Refused: tabs, control characters, a BOM, NEL/LS/PS and a lone CR; `...` and
  `%` lines; anchors, aliases, tags, merge keys, `?` keys; flow collections and JSON (also the
  harmless `{}` and `[]`); a list at column 0 (indent a list under its key); a quoted key at column 0
  or directly under metadata; duplicates of the keys above; any kind outside the allowlist, and any
  kind whose `apiVersion` is not the one paired with it (so a cluster-scoped CRD that borrows a core
  name is refused). Block scalars (`|`, `>`) are skipped, never interpreted. Allowlist, kind
  (apiVersion): Deployment, StatefulSet, DaemonSet, ReplicaSet (`apps/v1`); Job, CronJob
  (`batch/v1`); Pod, Service, ConfigMap, Secret, PersistentVolumeClaim, ServiceAccount (`v1`);
  Ingress, NetworkPolicy (`networking.k8s.io/v1`); Role, RoleBinding
  (`rbac.authorization.k8s.io/v1`); HorizontalPodAutoscaler (`autoscaling/v2`, `autoscaling/v1`);
  PodDisruptionBudget (`policy/v1`). Anything else (List, ClusterRole, Namespace, any CRD) is refused.
- **Round-1 review rules.** (1) A top-level `items` key is refused in every document: kubectl's
  builder flattens any object whose top-level `items` is an array (`Unstructured.IsList()`), applies
  the items and drops the wrapper, so a ConfigMap carrying a ClusterRole in `items` would apply the
  ClusterRole. A NESTED `items` (configMap and secret volume projections) is allowed. (2) Every
  document needs `metadata.name` (a DNS subdomain, plain or simply quoted); `generateName` is refused.
  (3) Cross-check against kubectl itself: the objects in the server dry run's JSON (kind and
  name, as `<resource>/<name>`: `deployment.apps/api`, `configmap/cfg`, ...) must equal, as a
  multiset, the set the scan read. The plan throws before the get on a difference (the apply's
  re-diff runs the same check and reports any failure as the cluster having changed), and the real
  apply's `-o name` output is checked the same way (after the fact it can only report, naming both
  sets). (4) Refusals never echo manifest text: only the rule, the document and
  line number and, for a plain key at column 0 or directly under metadata, the key name. When a
  scanned object is a `Secret`, kubectl's stderr snippet is replaced by `(stderr withheld: the
  manifest holds a Secret)`. (5) The plan hash is described under **The hashes** above.
- **What the scanner does NOT do.** It enforces scope only (namespaced allowlisted kinds, in the
  given namespace). An allowlisted kind can still be privileged: a pod with `hostPath` volumes,
  `privileged: true` containers, `hostPID`/`hostNetwork`, or a RoleBinding to a powerful ClusterRole.
  The approval preview (the plan's `diff`) is what shows those; the gateway's preview should too.
- Stated bounds. (U) The text kubectl prints for a namespace mismatch is not on the pages read; the
  scanner refuses a mismatch itself and the gateway parses the manifest again as a second layer.
  The manifest is written
  to a private 0700 directory under `NIMBUS_CONNECTOR_SCRATCH_DIR` (else the system temp directory);
  under the gateway on Windows that variable is required and the connector refuses without it.
- `permissions.network` stays empty: the API-server host lives in the kubeconfig and is the gateway's
  grant.

## Further bounds (security review, round 2)

- **A Secret withholds its part of the diff.** When the manifest holds a `Secret`, the plan's
  `diff` is the line `(diff withheld: the manifest holds a Secret)` followed by the diff of every
  object that is not a Secret; `hasDifferences` still covers all of them. Either side of a Secret's
  diff can carry plaintext. The plan reads live cluster state for every object it names.
  `diffSha256` covers that text, so the apply's re-diff sees a change to any other object but
  cannot see a change to a Secret (stated bound; the gateway refuses Secrets).
- **`planSha256` is an integrity check, not a capability.** It proves the apply carries the very
  context, namespace and manifest that were planned; a standalone client can compute it without running the
  plan. Under the gateway it is bound from the plan's own reply. A standalone prompt shows the
  manifest, not the diff: run `k8s_manifest_plan` first to see the diff.
- **The standalone audit log records the parameters,** the manifest included (a Secret's values
  too) when `NIMBUS_MCP_AUDIT_LOG` is set. Keep that log private.
- **The manifest file is re-read before the real apply** and the apply refused if it changed after
  the dry run (on Windows the 0600 mode is not enforced).
- The scanner is linear in the manifest size (a trailing-space regex that was quadratic is gone).

## See also

- [Kubernetes Connector Documentation](https://nimbus-agent.dev/user-guide/connectors/)
- [Nimbus Architecture Overview](https://nimbus-agent.dev/architecture-overview/)
- [HITL and Safety](https://nimbus-agent.dev/user-guide/hitl-and-safety/)

## License

AGPL-3.0
