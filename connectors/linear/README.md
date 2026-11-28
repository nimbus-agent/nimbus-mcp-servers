# Linear Connector

## What this is

First-party Nimbus MCP connector for [Linear](https://linear.app). It lets the Nimbus agent read
issues, projects, cycles, initiatives (the roadmap) and workspace members, and offers five
owner-approved writes: create and update an issue, comment on one, and add or remove its labels.

## Install

Bundled with Nimbus — no separate install required.

## Quickstart

```bash
nimbus connector auth linear
nimbus ask "Summarize my recent activity in Linear"
```

The Gateway injects the credential as an environment variable at spawn time; the connector itself
never touches the vault.

| Variable | Required | Purpose |
| --- | --- | --- |
| `LINEAR_API_KEY` | yes | A Linear API key, sent as the bare `Authorization: <key>` header (no `Bearer` prefix). Read on every call. |

Every request is a POST to `https://api.linear.app/graphql` (the host is fixed, not configurable),
through the redirect guard: any redirect is refused and the API key never follows one. Requests time
out after 15 seconds.

Tools exposed:

| Tool | Purpose |
| --- | --- |
| `linear_issue_list` | List issues, most recently updated first. Optional `teamId`, `stateName` and `assigneeId` filters; `first` 1-100 (default 50). |
| `linear_issue_get` | Get one issue by `issueId`: identifier, title, description, priority, state, team and assignee. |
| `linear_issue_create` (write) | Create an issue: `teamId` and `title` required; optional `description`, `priority` (0-4), `stateId` and `assigneeId`. |
| `linear_issue_update` (write) | `issueUpdate` on `issueId` with any of `title`, `description`, `stateId`, `priority` (0-4) and `assigneeId`. |
| `linear_comment_create` (write) | Add a comment (`body`) to the issue `issueId`. |
| `linear_issue_labels_add` (write) | `issueUpdate` with `addedLabelIds` only: one request that adds the label ids named and removes nothing. |
| `linear_issue_labels_remove` (write) | `issueUpdate` with `removedLabelIds` only: one request that removes the label ids named and adds nothing. A label is never deleted from the workspace. |
| `linear_project_list` | List projects; `first` 1-100 (default 50). |
| `linear_project_get` | Get one project by `projectId`, with its lead. |
| `linear_cycle_list` | List a team's cycles (`teamId` required); `first` 1-50 (default 20). |
| `linear_roadmap_list` | List initiatives (Linear's roadmap); `first` 1-50 (default 30). |
| `linear_member_list` | List workspace users (name, display name, email, active); `first` 1-100 (default 50). |

### The writes

All five writes are registered through `createWriteToolRegistrar`, so each asks for owner approval,
and each declares itself recoverable. Standalone, they are limited by
`NIMBUS_MCP_LINEAR_WRITE_SCOPE`, a comma-separated list of `kind:value` terms matched exactly; unset
or empty denies every write. The kinds are `team` and `issue`:

| Write | Scope term it needs |
| --- | --- |
| `linear_issue_create` | `team:<teamId>`, the `teamId` argument. |
| `linear_issue_update`, `linear_comment_create`, `linear_issue_labels_add`, `linear_issue_labels_remove` | `issue:<issueId>`, the `issueId` argument exactly as given. |

The two label tools never send `labelIds`, which would replace the whole set. They accept 1 to 50
distinct label ids (a repeated id is refused).

## See also

- [Nimbus Connectors Overview](https://nimbus-agent.dev/user-guide/connectors/)
- [Nimbus Architecture Overview](https://nimbus-agent.dev/architecture-overview/)
- [HITL and Safety](https://nimbus-agent.dev/user-guide/hitl-and-safety/)

## License

AGPL-3.0
