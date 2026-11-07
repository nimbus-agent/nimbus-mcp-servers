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
- `permissions.network` stays empty: the API-server host lives in the kubeconfig and is the gateway's
  grant.

## See also

- [Kubernetes Connector Documentation](https://nimbus-agent.dev/user-guide/connectors/)
- [Nimbus Architecture Overview](https://nimbus-agent.dev/architecture-overview/)
- [HITL and Safety](https://nimbus-agent.dev/user-guide/hitl-and-safety/)

## License

AGPL-3.0
