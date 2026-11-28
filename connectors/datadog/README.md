# Datadog Connector

## What this is

First-party Nimbus MCP connector for [Datadog](https://www.datadoghq.com). It is read-only and
exposes two tools to the Nimbus agent: `datadog_monitor_list` and `datadog_incident_list`. Useful
for incident correlation — "which monitors are defined, and what incidents are open?".

The gateway indexes and provides context from Datadog; that syncable lives in the Nimbus monorepo,
not here.

## Install

Bundled with Nimbus — no separate install required.

## Quickstart

```bash
nimbus connector auth datadog
nimbus ask "Summarize my recent activity in Datadog"
```

The gateway injects the credentials as environment variables at spawn time; the connector itself
never touches the vault. All are read on every call.

| Variable | Required | Purpose |
| --- | --- | --- |
| `DD_API_KEY` | yes | Sent as the `DD-API-KEY` header. |
| `DD_APP_KEY` | yes | Sent as the `DD-APPLICATION-KEY` header. Both keys must be set; one alone is refused. |
| `DD_SITE` | no | The Datadog site. Requests go to `https://api.<DD_SITE>`; defaults to `datadoghq.com`. |

Requests time out after 15 seconds. A redirect is followed only to the same origin or the same
host's http to https upgrade, at most 3 hops.

Tools exposed:

| Tool | Purpose |
| --- | --- |
| `datadog_monitor_list` | List monitors (`GET /api/v1/monitor`). Takes no arguments. |
| `datadog_incident_list` | List incidents (`GET /api/v2/incidents`), page size `limit` (integer 1 to 50, default 10). |

Both tools are reads; this connector has no write tools and so no write scope.

## See also

- [Nimbus Connectors Overview](https://nimbus-agent.dev/user-guide/connectors/)
- [Nimbus Architecture Overview](https://nimbus-agent.dev/architecture-overview/)
- [HITL and Safety](https://nimbus-agent.dev/user-guide/hitl-and-safety/)

## License

AGPL-3.0
