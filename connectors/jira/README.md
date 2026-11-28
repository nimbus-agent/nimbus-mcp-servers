# Jira Connector

## What this is

First-party Nimbus MCP connector for [Jira](https://www.atlassian.com/software/jira). It lets the
Nimbus agent search and read issues, list boards, sprints and epics, and read and act on Jira Service
Management Operations alerts. It also offers owner-approved writes: create, update, comment on,
transition and assign issues, and acknowledge or close an alert.

## Install

Bundled with Nimbus — no separate install required.

## Quickstart

```bash
nimbus connector auth jira
nimbus ask "Summarize my recent activity in Jira"
```

The Gateway injects the credentials as environment variables at spawn time; the connector itself
never touches the vault.

| Variable | Required | Purpose |
| --- | --- | --- |
| `JIRA_BASE_URL` | yes | The Jira site, e.g. `https://example.atlassian.net`. Trailing slashes are stripped, and a value that does not start with `http` gets `https://` prepended. A plain-http base is accepted as given. |
| `JIRA_EMAIL` | yes | The account email, the user half of the Basic credential. |
| `JIRA_API_TOKEN` | yes | The Atlassian API token, the password half of the Basic credential (`Authorization: Basic ...`). |
| `JIRA_CLOUD_ID` | no | The site's cloud id (a UUID), used only by the JSM Operations alert tools. Without it the id is discovered once per process, and only for an `https://*.atlassian.net` base; any other base needs this variable. |

The three required ones are read, and refused with "is not set" when empty, on every call.

Requests to the site (`${JIRA_BASE_URL}/rest/...`) go through the redirect guard and time out after
15 seconds: a redirected write is refused (it may or may not have been applied), and a read follows
only a same-origin redirect, so the Basic credential never reaches another host.

Tools exposed:

| Tool | Purpose |
| --- | --- |
| `jira_issue_list` | Search issues with `jql` (default `order by updated DESC`) via `POST /rest/api/3/search`; `startAt`, `maxResults` 1-100 (default 50). Returns summary, description, updated, status, issue type, priority and assignee. |
| `jira_issue_get` | Get one issue by `issueKey` (`GET /rest/api/3/issue/{key}`), with its comments. |
| `jira_issue_create` (write) | Create an issue: `projectKey` and `summary` required, optional `description` (plain text, sent as a one-paragraph Atlassian document) and `issueTypeName` (default `Task`). |
| `jira_issue_update` (write) | Set `summary` and/or `description` on an issue (at least one). |
| `jira_comment_add` (write) | Add a comment (`body`, plain text sent as a one-paragraph Atlassian document) to an issue. |
| `jira_issue_transitions_list` | List the workflow transitions available to an issue right now, with ids and required fields; read it before `jira_issue_transition`. |
| `jira_issue_transition` (write) | Move an issue through its workflow with a numeric `transitionId` from `jira_issue_transitions_list`. |
| `jira_issue_assign` (write) | Assign an issue to a Jira account id, or unassign it with `null`. |
| `jira_board_list` | List boards (`GET /rest/agile/1.0/board`); `startAt`, `maxResults` 1-50 (default 50). |
| `jira_sprint_list` | List a board's sprints by `boardId`; `startAt`, `maxResults` 1-50 (default 50). |
| `jira_epic_list` | List a project's epics (a JQL search on `projectKey`); `maxResults` 1-100 (default 50). |
| `jira_ops_alert_get` | One JSM Operations alert by id (status, acknowledged, message, priority, responders). |
| `jira_ops_alert_list` | List alerts (`query` up to 1,000 characters, `size` 1-100 default 25, `offset`, `sort` `createdAt` or `updatedAt`, `order`, `from`, `to`); `offset` plus `size` must stay under 20,000. |
| `jira_ops_alert_request_status` | Whether an asynchronous alert action was processed, by `requestId`. |
| `jira_ops_alert_acknowledge` (write) | Acknowledge an alert. Returns `accepted` and a `requestId`, not completion. |
| `jira_ops_alert_close` (write) | Close an alert. There is no reopen in this API. |

Every tool that puts an issue in the URL (`jira_issue_get`, `jira_issue_update`, `jira_comment_add`,
`jira_issue_transitions_list`, `jira_issue_transition`, `jira_issue_assign`) takes `issueKey` as an
issue key like `ENG-7` or a numeric issue id only. A `..`, a slash, a space or anything else is
refused before any request, not encoded.

### The writes

All seven writes are registered through `createWriteToolRegistrar`, so each asks for owner approval.
Standalone, they are limited by `NIMBUS_MCP_JIRA_WRITE_SCOPE`, a comma-separated list of
`kind:value` terms matched exactly; unset or empty denies every write. The kinds are `project`,
`issue` and `alert`:

| Write | Scope term it needs | Declared recoverable |
| --- | --- | --- |
| `jira_issue_create` | `project:<KEY>`, the `projectKey` argument | yes |
| `jira_issue_update`, `jira_comment_add` | `issue:<KEY>`, the `issueKey` argument | yes |
| `jira_issue_transition` | `issue:<KEY>` | no: the status before the move is recorded first, since workflows can be one-way |
| `jira_issue_assign` | `issue:<KEY>` | no: the previous assignee's account id is recorded first |
| `jira_ops_alert_acknowledge`, `jira_ops_alert_close` | `alert:<alertId>` (exact id only) | no: the alert's status, acknowledged flag, message and priority are recorded first |

`jira_issue_assign` sends `PUT /rest/api/3/issue/{key}/assignee` with `{accountId}`. `accountId` is
required and nullable, so the intent is always stated: a Jira account id assigns, `null` unassigns.
A name, an email or `-1` (Jira's "project default assignee") is refused at the schema, and so is an
`issueKey` that is not a key like `ENG-7` or a numeric id.

## JSM Operations alerts (successor to Opsgenie)

Opsgenie reaches end of sale on 2025-06-04 and end of support on 2027-04-05 (Atlassian's
announcement, <https://www.atlassian.com/blog/announcements/evolution-of-it-operations>); its
successor is Jira Service Management Operations. The five `jira_ops_alert_*` tools use the JSM
Operations REST API at `https://api.atlassian.com/jsm/ops/api/{cloudId}/v1` (a fixed host), with the
same email and API token as the rest of this connector. Alert and request ids are letters, digits,
`_` and `-` only, and the alert id is the id, not a tinyId or alias.

Both alert writes take no body (the API defines none). Incidents are Jira issues, so resolving one is
`jira_issue_transition`; the Operations API has no incident resolve.

The cloud id comes from the optional `JIRA_CLOUD_ID`. Without it, for an `*.atlassian.net` base, the
connector asks `{site}/_edge/tenant_info` once per process (with the same Basic header, no redirect
followed) and refuses to make any ops call if that fails. Any request to the Operations API that is
answered with a redirect is refused.

Needs Jira Service Management Operations on the site; the account's own permissions apply (a scoped
token needs `read:ops-alert:jira-service-management` and `write:ops-alert:jira-service-management`).

Not verified against a live site: whether an unscoped API token is accepted at the gateway host
(Atlassian's token page says unscoped tokens target the site URL and scoped ones the gateway), whether
the path `id` also accepts a `tinyId` (the tools say alert id only), and the list endpoint's maximum
`size` and `sort` vocabulary (the connector caps at 100 and `createdAt`/`updatedAt`).

## See also

- [Nimbus Connectors Overview](https://nimbus-agent.dev/user-guide/connectors/)
- [Nimbus Architecture Overview](https://nimbus-agent.dev/architecture-overview/)
- [HITL and Safety](https://nimbus-agent.dev/user-guide/hitl-and-safety/)

## License

AGPL-3.0
