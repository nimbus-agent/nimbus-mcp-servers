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

Branches and pull requests: `github_ref_get` reads a branch, tag or commit as a commit sha;
`github_branch_create` makes a branch from a ref (optionally pinned with `expectedSha`, so a branch
that moved after you approved is refused); `github_pr_create` opens a pull request (title and body
are sent verbatim, no draft unless asked); `github_pr_update` edits a pull request's title, body or
base only, and records the old values first. A fine-grained token needs Contents: write for branch
create and Pull requests: write for PR create and update.

## Behaviour notes

- Multi-file commits: `github_files_get` reads up to 50 files at a ref; `github_commit_prepare` (a prepare
  tool, see the architecture doc) returns the branch head and each file's current state for the owner to
  approve; `github_file_commit` commits whole text files as ONE commit through the Git Data API
  (blobs, a tree on the head's tree, a commit whose only parent is the head, then a ref update with
  `force: false`) and only when the branch head is still `expectedHeadSha`. At most 20 files, and the old
  plus new content at most 192 KiB (the prepare refuses rather than truncates). Text files only: no
  deletes, no mode changes, and a symlink, submodule or binary file is refused. Existing files keep their
  mode. Bounds, each a live-check item: the status and message of a non-fast-forward ref update (the
  page lists only 409 and 422, and any of them is surfaced as "head moved or ref update refused"),
  whether API commits made with a token are signed, and the status of a ref update refused by branch
  protection (surfaced verbatim).

## See also

- [Github Connector Documentation](https://nimbus-agent.dev/user-guide/connectors/)
- [Nimbus Architecture Overview](https://nimbus-agent.dev/architecture-overview/)
- [HITL and Safety](https://nimbus-agent.dev/user-guide/hitl-and-safety/)

## License

AGPL-3.0
