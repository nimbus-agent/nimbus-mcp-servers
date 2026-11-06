# Jira Connector

## What this is

Nimbus MCP connector for Jira. Indexes and provides context from Jira to the Nimbus agent.

## Install

Bundled with Nimbus — no separate install required.

## Quickstart

```bash
nimbus connector auth jira
nimbus ask "Summarize my recent activity in Jira"
```

## JSM Operations alerts (successor to Opsgenie)

Opsgenie reaches end of sale on 2025-06-04 and end of support on 2027-04-05 (Atlassian's
announcement, <https://www.atlassian.com/blog/announcements/evolution-of-it-operations>); its
successor is Jira Service Management Operations. Five tools use the JSM Operations REST API at
`https://api.atlassian.com/jsm/ops/api/{cloudId}/v1`, with the same email and API token as the rest
of this connector:

| Tool | Purpose |
| --- | --- |
| `jira_ops_alert_get` | One alert by id (status, acknowledged, message, priority, responders). |
| `jira_ops_alert_list` | List alerts (`query`, `size` 1-100, `offset`, `sort`, `order`, `from`, `to`). |
| `jira_ops_alert_request_status` | Whether an asynchronous action was processed, by `requestId`. |
| `jira_ops_alert_acknowledge` (write) | Acknowledge an alert. Returns `accepted` and a `requestId`, not completion. |
| `jira_ops_alert_close` (write) | Close an alert. There is no reopen in this API. |

Both writes need owner approval, record the alert's state first (neither can be undone through
this API, so `recoverable` is false), and take no body: the API defines none. Incidents are Jira
issues, so resolving one is `jira_issue_transition`; the Operations API has no incident resolve.

The cloud id comes from the optional `JIRA_CLOUD_ID` secret. Without it the connector asks
`{site}/_edge/tenant_info` once per process (with the same Basic header, no redirect followed) and
refuses to make any ops call if that fails. Outside the gateway, scope the writes with
`NIMBUS_MCP_JIRA_WRITE_SCOPE=alert:<alertId>`: alerts are authorised by exact id only.

Needs Jira Service Management Operations on the site; the account's own permissions apply (a scoped
token needs `read:ops-alert:jira-service-management` and `write:ops-alert:jira-service-management`).

Not verified against a live site: whether an unscoped API token is accepted at the gateway host
(Atlassian's token page says unscoped tokens target the site URL and scoped ones the gateway), whether
the path `id` also accepts a `tinyId` (the tools say alert id only), and the list endpoint's maximum
`size` and `sort` vocabulary (the connector caps at 100 and `createdAt`/`updatedAt`).

## See also

- [Jira Connector Documentation](https://nimbus-agent.dev/user-guide/connectors/)
- [Nimbus Architecture Overview](https://nimbus-agent.dev/architecture-overview/)
- [HITL and Safety](https://nimbus-agent.dev/user-guide/hitl-and-safety/)

## License

AGPL-3.0
