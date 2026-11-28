# Grafana Connector

## What this is

First-party Nimbus MCP connector for [Grafana](https://grafana.com). It is read-only and exposes two
tools to the Nimbus agent: `grafana_alert_list` and `grafana_dashboard_list`. Useful for incident
correlation — "which alert rules exist for this service, and which dashboard shows it?".

The gateway indexes and provides context from Grafana; that syncable lives in the Nimbus monorepo,
not here.

## Install

Bundled with Nimbus — no separate install required.

## Quickstart

```bash
nimbus connector auth grafana
nimbus ask "Summarize my recent activity in Grafana"
```

The gateway injects the credentials as environment variables at spawn time; the connector itself
never touches the vault. Both variables are read on every call.

| Variable | Required | Purpose |
| --- | --- | --- |
| `GRAFANA_URL` | yes | The Grafana instance root. One trailing `/` is dropped. There is no default. |
| `GRAFANA_API_TOKEN` | yes | Sent as `Authorization: Bearer <token>`. |

Tools exposed:

| Tool | Purpose |
| --- | --- |
| `grafana_alert_list` | List alert rules through the Ruler API (`GET /api/ruler/grafana/api/v1/rules`). Takes no arguments. |
| `grafana_dashboard_list` | Search dashboards (`GET /api/search?type=dash-db`), optionally filtered by a `query` string (empty by default). |

A non-2xx answer is thrown as `Grafana <status>: <first 400 characters of the body>`. Both tools are
reads; this connector has no write tools and so no write scope.

## See also

- [Nimbus Connectors Overview](https://nimbus-agent.dev/user-guide/connectors/)
- [Nimbus Architecture Overview](https://nimbus-agent.dev/architecture-overview/)
- [HITL and Safety](https://nimbus-agent.dev/user-guide/hitl-and-safety/)

## License

AGPL-3.0
