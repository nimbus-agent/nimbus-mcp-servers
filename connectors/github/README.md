# Github Connector

## What this is

Nimbus MCP connector for Github. Indexes and provides context from Github to the Nimbus agent.

## Install

Bundled with Nimbus — no separate install required.

## Quickstart

```bash
nimbus connector auth github
nimbus ask "Summarize my recent activity in Github"
```

## GitHub Enterprise Server

Set `GITHUB_API_BASE_URL` to the server's API root, for example `https://ghe.example.com/api/v3`, and
the `github` and `github-actions` connectors send every request there instead of `api.github.com`.
`GITHUB_PAT` goes to that host, so point it only at a server you trust. Standalone, add the host to
your sandbox or network allow-list yourself; the manifest lists `api.github.com` only.

## Writes

Besides merging, closing and creating, the connector can comment on an issue or a pull request's
conversation, add labels, add assignees, and open or close an issue. Labels and assignees are
**add-only**: no tool removes or replaces one. Each write asks for approval, and standalone is limited
by `NIMBUS_MCP_GITHUB_WRITE_SCOPE=repo:<owner>/<repo>`.

## See also

- [Github Connector Documentation](https://nimbus-agent.dev/user-guide/connectors/)
- [Nimbus Architecture Overview](https://nimbus-agent.dev/architecture-overview/)
- [HITL and Safety](https://nimbus-agent.dev/user-guide/hitl-and-safety/)

## License

AGPL-3.0
