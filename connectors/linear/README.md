# Linear Connector

## What this is

Nimbus MCP connector for Linear. Indexes and provides context from Linear to the Nimbus agent.

## Install

Bundled with Nimbus — no separate install required.

## Quickstart

```bash
nimbus connector auth linear
nimbus ask "Summarize my recent activity in Linear"
```

## Writes

`linear_issue_create`, `linear_issue_update`, `linear_comment_create`, `linear_issue_labels_add` and
`linear_issue_labels_remove` each ask for approval; standalone they are limited by
`NIMBUS_MCP_LINEAR_WRITE_SCOPE=issue:<issueId>` (or `team:<teamId>` for a create).

| Tool | What it does |
| --- | --- |
| `linear_issue_labels_add` | `issueUpdate` with `addedLabelIds` only: one request that adds the label ids named and removes nothing. |
| `linear_issue_labels_remove` | `issueUpdate` with `removedLabelIds` only: one request that removes the label ids named and adds nothing. A label is never deleted from the workspace. |

Neither ever sends `labelIds`, which would replace the whole set. A list of 1 to 50 distinct label ids
is accepted. Every request goes to `https://api.linear.app/graphql` through the redirect guard: all
of them are POSTs, so any redirect is refused and the API key never follows one.

## See also

- [Linear Connector Documentation](https://nimbus-agent.dev/user-guide/connectors/)
- [Nimbus Architecture Overview](https://nimbus-agent.dev/architecture-overview/)
- [HITL and Safety](https://nimbus-agent.dev/user-guide/hitl-and-safety/)

## License

AGPL-3.0
