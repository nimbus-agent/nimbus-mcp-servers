# Pagerduty Connector

## What this is

Nimbus MCP connector for Pagerduty. Indexes and provides context from Pagerduty to the Nimbus agent.

## Install

Bundled with Nimbus — no separate install required.

## Quickstart

```bash
nimbus connector auth pagerduty
nimbus ask "Summarize my recent activity in Pagerduty"
```

## Configuration

| Variable | Needed for | Notes |
| --- | --- | --- |
| `PAGERDUTY_API_TOKEN` | every tool | REST API token. |
| `PAGERDUTY_FROM_EMAIL` | `pd_incident_acknowledge`, `pd_incident_resolve` | Email of a valid user on the account; sent as the `From` header PagerDuty requires on `PUT /incidents/{id}`. Must look like an email; a write is refused before any request when it is missing or malformed. The gateway is expected to inject it from the Vault key `pagerduty.from_email`. |

## Write tools

- `pd_incident_acknowledge` / `pd_incident_resolve` send `PUT /incidents/{id}` with `{"incident":{"type":"incident_reference","status":"acknowledged"|"resolved"}}` ([reference](https://docs.pagerduty.com/developer/api/reference/rest/incidents/update-incident)). Neither can be undone through these tools; the incident's prior state is recorded in the audit.
- `pd_incident_escalate` is **not supported**: the update-incident reference documents no escalation field in its request body, so the tool always refuses (`NOT_SUPPORTED`) before any request.

## See also

- [Pagerduty Connector Documentation](https://nimbus-agent.dev/user-guide/connectors/)
- [Nimbus Architecture Overview](https://nimbus-agent.dev/architecture-overview/)
- [HITL and Safety](https://nimbus-agent.dev/user-guide/hitl-and-safety/)

## License

AGPL-3.0
