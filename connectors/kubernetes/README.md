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
- `k8s_manifest_plan {namespace, manifest}` and `k8s_manifest_apply {namespace, manifest,
  manifestSha256}` are a pair. The plan is a PREPARE tool (it changes nothing): it scans the manifest,
  asks the API server for `kubectl apply --server-side --dry-run=server --field-manager=nimbus -o name`
  and `kubectl diff --server-side --field-manager=nimbus`, and returns `{manifestSha256, namespace,
  objects, scanned, diff, hasDifferences}` (one JSON item, under 256 KiB; a diff over 64 KiB is
  refused, so the owner never approves what the preview cannot show). The apply takes the same
  manifest and the hash the plan returned, re-runs every check, refuses on a different hash before any
  process starts, and runs `kubectl apply --server-side --field-manager=nimbus`. `--force-conflicts`
  is never passed. A manifest is at most 262,144 UTF-8 bytes. In standalone mode the plan needs the
  write scope (`NIMBUS_MCP_KUBERNETES_WRITE_SCOPE=namespace:<ns>`) and is audited as `prepared`.
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
- Stated bounds. (U) The text kubectl prints for a namespace mismatch is not on the pages read; the
  scanner refuses a mismatch itself and the gateway parses the manifest again as a second layer.
  `kubectl diff` runs the program `KUBECTL_EXTERNAL_DIFF` names, which the connector REMOVES from the
  child; the default `diff -u -N` must therefore be on `PATH`, on Windows too. The manifest is written
  to a private 0700 directory under `NIMBUS_CONNECTOR_SCRATCH_DIR` (else the system temp directory);
  under the gateway on Windows that variable is required and the connector refuses without it.
- `permissions.network` stays empty: the API-server host lives in the kubeconfig and is the gateway's
  grant.

## See also

- [Kubernetes Connector Documentation](https://nimbus-agent.dev/user-guide/connectors/)
- [Nimbus Architecture Overview](https://nimbus-agent.dev/architecture-overview/)
- [HITL and Safety](https://nimbus-agent.dev/user-guide/hitl-and-safety/)

## License

AGPL-3.0
