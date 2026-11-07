# Azure Connector

## What this is

Nimbus MCP connector for Azure. Indexes and provides context from Azure to the Nimbus agent.

## Install

Bundled with Nimbus — no separate install required.

## Quickstart

```bash
nimbus connector auth azure
nimbus ask "Summarize my recent activity in Azure"
```

## Behaviour notes

- `azure_aks_node_pool_get` runs `az aks nodepool show` and returns only the keys of `count, vmSize,
  mode, powerState, provisioningState, orchestratorVersion, enableAutoScaling, minCount, maxCount`
  that the reply holds. The command's page does not list its output fields: live check the keys.

## See also

- [Azure Connector Documentation](https://nimbus-agent.dev/user-guide/connectors/)
- [Nimbus Architecture Overview](https://nimbus-agent.dev/architecture-overview/)
- [HITL and Safety](https://nimbus-agent.dev/user-guide/hitl-and-safety/)

## License

AGPL-3.0
