# Gcp Connector

## What this is

First-party Nimbus MCP connector for Google Cloud, driven through the `gcloud` CLI (and `kubectl` for
GKE). It lists the Cloud Run services of a project and region, reads one GKE deployment, and offers two
owner-approved write tools: deploying an image to Cloud Run and restarting a GKE deployment's rollout.
`gcp_gke_workload_get` is the before-state of the restart.

## Install

Bundled with Nimbus — no separate install required. The connector runs `gcloud`, and for the GKE tools
`kubectl` too; both must be installed and on `PATH`, and the GKE tools also need
`gke-gcloud-auth-plugin`.

## Quickstart

```bash
nimbus connector auth gcp
nimbus ask "Summarize my recent activity in Gcp"
```

The gateway injects credentials as environment variables at spawn time; the connector itself never
touches the vault. The child process gets the connector's whole environment, so `gcloud` signs in
however it does.

| Variable | Required | Purpose |
| --- | --- | --- |
| `GOOGLE_APPLICATION_CREDENTIALS` | no | A key file for `gcloud`; re-set to its trimmed value when set and non-empty. |
| `NIMBUS_CONNECTOR_SCRATCH_DIR` | no | An absolute path under which the GKE tools make their private kubeconfig directory; a relative value is refused. Default: the system temp directory. |
| `NIMBUS_MCP_GCP_WRITE_SCOPE` | standalone writes only | The write allow-list; see [The writes](#the-writes). Unset means no write is authorised. |

The project is always the call's `projectId`; `GOOGLE_CLOUD_PROJECT` is not read by this connector.

Reads run `gcloud ... --format json`. A non-zero exit is reported as `gcloud exited <code>:` followed by
the first 500 characters of stderr. Every caller-supplied string is checked by the `cliArg` schema from
`shared/cli-json-kit.ts` before the CLI runs: it refuses an empty value, a leading `-` and control
characters. On Windows, where `gcloud` is a batch file, the spawn layer also refuses a value carrying
`cmd.exe` metacharacters.

Tools exposed:

| Tool | Purpose |
| --- | --- |
| `gcp_cloud_run_service_list` | List the Cloud Run services of a project and region (`projectId`, `region`; `gcloud run services list`). |
| `gcp_gke_workload_get` | One GKE deployment (`projectId`, `location`, `cluster`, `namespace`, `deployment`): `name`, `namespace`, `replicas`, `readyReplicas`, `generation`, `observedGeneration`, `restartedAt`, `images`. A `NotFound` from `kubectl` is `deployment not found`; a failure to fetch cluster credentials is reported as itself. |
| `gcp_cloud_run_deploy` (write) | Deploy `image` to the Cloud Run `service` in `projectId` and `region` (`gcloud run deploy --quiet`). Returns `{ok: true}`. |
| `gcp_gke_workload_restart` (write) | `kubectl rollout restart deployment <deployment> -n <namespace>` on the given GKE cluster (same five arguments as the get). Returns `{ok: true}`. |

The two GKE tools fetch cluster credentials with `gcloud container clusters get-credentials
--location=<location>` into a private, initially empty kubeconfig that is removed afterwards, so the
owner's `~/.kube/config` is neither read nor changed. `--location` replaces `--zone`, which makes a
regional cluster work.

### The writes

Both are registered through `createWriteToolRegistrar` (`shared/consent-kit.ts`) and declare
`recoverable: true`, so neither captures a pre-state. Standalone, each needs owner consent and a target
allowed by `NIMBUS_MCP_GCP_WRITE_SCOPE`, a comma-separated list of `kind:value` terms matched exactly (no
prefix match; an empty or unset scope allows nothing, and an unknown kind fails at startup). The only
kind is `project`, taken from the call's `projectId`.

| Write | Changes | Scope term |
| --- | --- | --- |
| `gcp_cloud_run_deploy` | Deploys the image to the named service. | `project:<projectId>` |
| `gcp_gke_workload_restart` | Triggers a rolling restart of the deployment. | `project:<projectId>` |

## See also

- [Nimbus Connectors Overview](https://nimbus-agent.dev/user-guide/connectors/)
- [Nimbus Architecture Overview](https://nimbus-agent.dev/architecture-overview/)
- [HITL and Safety](https://nimbus-agent.dev/user-guide/hitl-and-safety/)

## License

AGPL-3.0
