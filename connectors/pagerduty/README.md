# Pagerduty Connector

## What this is

First-party Nimbus MCP connector for [PagerDuty](https://www.pagerduty.com). It lists and reads
incidents, and offers three owner-approved write tools that acknowledge, resolve or escalate one.

## Install

Bundled with Nimbus — no separate install required.

## Quickstart

```bash
nimbus connector auth pagerduty
nimbus ask "Summarize my recent activity in Pagerduty"
```

The gateway injects credentials as environment variables at spawn time; the connector itself never
touches the vault. Both variables are read on every call.

| Variable | Required | Purpose |
| --- | --- | --- |
| `PAGERDUTY_API_TOKEN` | yes | REST API token, sent as `Authorization: Token token=<token>`. |
| `PAGERDUTY_FROM_EMAIL` | for the three write tools | Email of a valid user on the account; sent as the `From` header PagerDuty requires on `PUT /incidents/{id}`. It must look like an email (at most 254 characters, no whitespace, one `@`, a dot inside the domain); a write, and its audit pre-state read, is refused before any request when it is missing or malformed. The gateway is expected to inject it from the Vault key `pagerduty.from_email`. |
| `NIMBUS_MCP_PAGERDUTY_WRITE_SCOPE` | standalone writes only | The write allow-list; see [The writes](#the-writes). Unset means no write is authorised. |

Requests go to `https://api.pagerduty.com`, which is not configurable, with
`Accept: application/vnd.pagerduty+json;version=2`. Every request goes through `guardedFetch`, so it
times out after 15 seconds, a redirect on a write is refused (the write may or may not have been
applied), and a read follows a redirect only to the same origin, so the token never goes to another host.

Tools exposed:

| Tool | Purpose |
| --- | --- |
| `pd_incident_list` | List incidents (`GET /incidents`). `statuses` is any of `triggered`, `acknowledged`, `resolved` (default `triggered` and `acknowledged`); `limit` is 1 to 100 (default 25). |
| `pd_incident_get` | Get one incident by `incidentId` (`GET /incidents/{id}`, the id URL-encoded). |
| `pd_incident_acknowledge` (write) | Set an incident's status to `acknowledged`. |
| `pd_incident_resolve` (write) | Set an incident's status to `resolved`. |
| `pd_incident_escalate` (write) | Escalate an incident to `escalationLevel` (an integer, 1 to 20) of its escalation policy. |

### The writes

All three are registered through `createWriteToolRegistrar` (`shared/consent-kit.ts`), take an
`incidentId` of 1 to 64 letters and digits, and send `PUT /incidents/{id}` with
`{"incident":{"type":"incident_reference", ...}}` carrying either `status` or `escalation_level`
([reference](https://docs.pagerduty.com/developer/api/reference/rest/incidents/update-incident)).
`escalation_level` is documented in PagerDuty's OpenAPI schema
([PagerDuty/api-schema](https://github.com/PagerDuty/api-schema), `reference/REST/openapiv3.json`,
retrieved 2026-11-06). Each declares `recoverable: false`: these tools offer no unacknowledge, reopen or
de-escalate, so before the write the incident's `status`, `assignments`, `escalation_level` and
`escalation_policy` are read and recorded in the audit as the pre-state.

Standalone, each needs owner consent and a target allowed by `NIMBUS_MCP_PAGERDUTY_WRITE_SCOPE`, a
comma-separated list of `kind:value` terms matched exactly (no prefix match; an empty or unset scope
allows nothing, and an unknown kind fails at startup). The only kind is `incident`, whose value is the
`incidentId`, so the scope is `incident:<incidentId>`.

## See also

- [Nimbus Connectors Overview](https://nimbus-agent.dev/user-guide/connectors/)
- [Nimbus Architecture Overview](https://nimbus-agent.dev/architecture-overview/)
- [HITL and Safety](https://nimbus-agent.dev/user-guide/hitl-and-safety/)

## License

AGPL-3.0
