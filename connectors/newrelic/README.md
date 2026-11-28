# New Relic Connector

## What this is

First-party Nimbus MCP connector for [New Relic](https://newrelic.com). It is read-only and exposes
two tools to the Nimbus agent: `newrelic_application_list` and `newrelic_alert_violations`. Useful
for incident correlation — "which APM applications do we have, and which alerts have fired?".

The gateway indexes and provides context from New Relic; that syncable lives in the Nimbus monorepo,
not here.

## Install

Bundled with Nimbus — no separate install required.

## Quickstart

```bash
nimbus connector auth newrelic
nimbus ask "Summarize my recent activity in New Relic"
```

The gateway injects the credential as an environment variable at spawn time; the connector itself
never touches the vault. It is read on every call.

| Variable | Required | Purpose |
| --- | --- | --- |
| `NEW_RELIC_API_KEY` | yes | The API key, sent bare in the `X-Api-Key` header (no scheme). |

Requests go to `https://api.newrelic.com` (not configurable), time out after 15 seconds, and follow
a redirect only to the same origin or the same host's http to https upgrade, at most 3 hops.

Tools exposed:

| Tool | Purpose |
| --- | --- |
| `newrelic_application_list` | List APM applications (`GET /v2/applications.json`). Takes no arguments. |
| `newrelic_alert_violations` | List recent alert violations (`GET /v2/alerts_violations.json`); `only_open` (default false) restricts it to open ones. |

Both tools are reads; this connector has no write tools and so no write scope.

## See also

- [Nimbus Connectors Overview](https://nimbus-agent.dev/user-guide/connectors/)
- [Nimbus Architecture Overview](https://nimbus-agent.dev/architecture-overview/)
- [HITL and Safety](https://nimbus-agent.dev/user-guide/hitl-and-safety/)

## License

AGPL-3.0
