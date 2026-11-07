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

`PRIVATE-TOKEN` is never sent to another origin: a redirect on a write is refused, and a read
follows at most 3 redirects, only to the same origin or the same host's http -> https upgrade
(never https -> http). A plain-http `GITLAB_API_BASE_URL` is accepted for a self-hosted server; the
token is then sent in clear.

## Behaviour notes

- Multi-file commits: `gitlab_files_get` reads up to 50 files at a ref (file paths are encoded with
  `encodeURIComponent` and every `.` as `%2E`, as the API page's examples do); `gitlab_commit_prepare`
  (a prepare tool) returns the branch head and each file's `last_commit_id`, mode and current content;
  `gitlab_commit_create` checks the branch head is still `expectedHeadSha`, reads each existing file at
  that head, and posts ONE commit whose update actions carry that `last_commit_id` (creates carry none),
  never forced. At most 20 files, old plus new content at most 192 KiB, text files only.
- Stated race bound: the Commits API has no parameter that makes a commit conditional on the branch
  head (`last_commit_id` is per file, and only for update, move and delete). A change to OTHER files
  between the head check and the POST is not detected; the result reports `movedHead: true` when the new
  commit's parent is not the approved head. Live check: the message of a `last_commit_id` mismatch.

## See also

- [Gitlab Connector Documentation](https://nimbus-agent.dev/user-guide/connectors/)
- [Nimbus Architecture Overview](https://nimbus-agent.dev/architecture-overview/)
- [HITL and Safety](https://nimbus-agent.dev/user-guide/hitl-and-safety/)

## License

AGPL-3.0
