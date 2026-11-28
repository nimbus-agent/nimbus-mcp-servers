# Azure Connector

## What this is

First-party Nimbus MCP connector for Azure, driven through the `az` CLI. It lists the App Services of a
resource group, reads one AKS node pool, and offers two owner-approved write tools: restarting an App
Service and scaling an AKS node pool. `azure_aks_node_pool_get` is the before-state of the scale.

## Install

Bundled with Nimbus — no separate install required. The connector runs the `az` CLI, which must be
installed and on `PATH`; with it missing, the tools fail with the spawn error.

## Quickstart

```bash
nimbus connector auth azure
nimbus ask "Summarize my recent activity in Azure"
```

The gateway injects credentials as environment variables at spawn time; the connector itself never
touches the vault. It reads no variable by name for the cloud: the child `az` process gets the
connector's whole environment and signs in however `az` does.

| Variable | Required | Purpose |
| --- | --- | --- |
| `NIMBUS_MCP_AZURE_WRITE_SCOPE` | standalone writes only | The write allow-list; see [The writes](#the-writes). Unset means no write is authorised. |

Every call runs `az <group> <subcommand> ... -o json` (the writes run without an output flag). A
non-zero exit is reported as `az exited <code>:` followed by the first 500 characters of stderr. Every
caller-supplied string is checked by the `azCliArg` schema from `shared/cli-json-kit.ts` before the CLI
runs: it refuses an empty value, a leading `-`, control characters, a leading `@` and `=@` anywhere
(`az` would read the value from a file). On Windows, where `az` is a batch file, the spawn layer also
refuses a value carrying `cmd.exe` metacharacters.

Tools exposed:

| Tool | Purpose |
| --- | --- |
| `azure_app_service_list` | List the App Services of a resource group (`subscriptionId`, `resourceGroup`; `az webapp list`). |
| `azure_aks_node_pool_get` | One AKS node pool (`subscriptionId`, `resourceGroup`, `clusterName`, `poolName`; `az aks nodepool show`), reduced to those of `count`, `vmSize`, `mode`, `powerState` (its `code`, as a string), `provisioningState`, `orchestratorVersion`, `enableAutoScaling`, `minCount`, `maxCount` that the reply holds. A reply with none of them is `node pool not found`. |
| `azure_app_service_restart` (write) | Restart an App Service (`subscriptionId`, `resourceGroup`, `name`; `az webapp restart`). Returns `{ok: true}`. |
| `azure_aks_node_pool_scale` (write) | Scale a node pool to `nodeCount` (integer, 0 or more; `az aks nodepool scale --node-count`) for the same four identifiers as the get. Returns `{ok: true}`. |

The command's documentation does not list the output fields of `az aks nodepool show`, so the keys above
are those the code looks for, not a verified list.

### The writes

Both are registered through `createWriteToolRegistrar` (`shared/consent-kit.ts`) and declare
`recoverable: true`, so neither captures a pre-state. Standalone, each needs owner consent and a target
allowed by `NIMBUS_MCP_AZURE_WRITE_SCOPE`, a comma-separated list of `kind:value` terms matched exactly
(no prefix match; an empty or unset scope allows nothing, and an unknown kind fails at startup). The only
kind is `resource_group`, taken from the call's `resourceGroup`.

| Write | Changes | Scope term |
| --- | --- | --- |
| `azure_app_service_restart` | Restarts the named App Service. | `resource_group:<resourceGroup>` |
| `azure_aks_node_pool_scale` | Sets the node pool's node count. | `resource_group:<resourceGroup>` |

## See also

- [Nimbus Connectors Overview](https://nimbus-agent.dev/user-guide/connectors/)
- [Nimbus Architecture Overview](https://nimbus-agent.dev/architecture-overview/)
- [HITL and Safety](https://nimbus-agent.dev/user-guide/hitl-and-safety/)

## License

AGPL-3.0
