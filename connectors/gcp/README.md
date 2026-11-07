# Gcp Connector

## What this is

Nimbus MCP connector for Gcp. Indexes and provides context from Gcp to the Nimbus agent.

## Install

Bundled with Nimbus — no separate install required.

## Quickstart

```bash
nimbus connector auth gcp
nimbus ask "Summarize my recent activity in Gcp"
```

## Behaviour notes

- `gcp_gke_workload_restart` and `gcp_gke_workload_get` fetch cluster credentials with
  `gcloud container clusters get-credentials --location=<location>` into a private, initially empty
  kubeconfig removed afterwards, so the owner's `~/.kube/config` is neither read nor changed.
  `--location` replaces `--zone`, which makes a regional cluster work. `gke-gcloud-auth-plugin` must be
  installed. Live check: that `get-credentials` into a fresh `KUBECONFIG` sets the current context.
- `gcp_gke_workload_get` takes the restart's arguments and returns `{name, namespace, replicas,
  readyReplicas, generation, observedGeneration, restartedAt, images}`.

## See also

- [Gcp Connector Documentation](https://nimbus-agent.dev/user-guide/connectors/)
- [Nimbus Architecture Overview](https://nimbus-agent.dev/architecture-overview/)
- [HITL and Safety](https://nimbus-agent.dev/user-guide/hitl-and-safety/)

## License

AGPL-3.0
