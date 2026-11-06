# Gitlab Connector

## What this is

Nimbus MCP connector for Gitlab. Indexes and provides context from Gitlab to the Nimbus agent.

## Install

Bundled with Nimbus — no separate install required.

## Quickstart

```bash
nimbus connector auth gitlab
nimbus ask "Summarize my recent activity in Gitlab"
```

## Writes

`gitlab_branch_create` (optionally pinned with `expectedSha`, so a ref that moved after you approved is refused), `gitlab_mr_create` and `gitlab_mr_update` create a branch from a ref, open a
merge request (title and description verbatim; no draft, labels or assignees) and edit a merge
request's title, description or target branch (the old values are recorded first; its state is never
touched). Each write asks for approval; standalone is limited by
`NIMBUS_MCP_GITLAB_WRITE_SCOPE=repo:<group/project>`.

`PRIVATE-TOKEN` is never sent to another origin: a redirect on a write is refused, a read follows a
redirect only within the same https origin (at most 3 hops), and `GITLAB_API_BASE_URL` must be https
(plain http only for localhost).

## See also

- [Gitlab Connector Documentation](https://nimbus-agent.dev/user-guide/connectors/)
- [Nimbus Architecture Overview](https://nimbus-agent.dev/architecture-overview/)
- [HITL and Safety](https://nimbus-agent.dev/user-guide/hitl-and-safety/)

## License

AGPL-3.0
