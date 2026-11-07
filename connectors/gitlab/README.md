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
  head, so the head check before the write is NOT atomic with it. The files themselves are protected by
  `last_commit_id` (per file, and only for update, move and delete): GitLab refuses an update of a file
  that changed since it was read at the approved head. A commit to OTHER files that lands between the
  head check and the write is not detected before the write; the result reports `movedHead: true`
  afterwards when the new commit's parent is not the approved head.
- Symlinks and submodules: the Repository Files API reports no mode, so a symlink reads as a text file
  holding its target. Before any write the tools read the tree listing of each target's directory
  (`GET /projects/:id/repository/tree`, paged 100 at a time) and refuse a mode `120000` (symlink) or
  `160000` (submodule), anything that is not a `blob`, and an existing file the listing does not show.
  The tree page documents `ref` as a branch or tag; a commit sha is what is passed, which is a live-check
  item along with the mode strings (`120000`, `160000`) and the `commit` type the page does not list. Live check: the message of a `last_commit_id` mismatch.
- Paths: a file path with a control, format (bidi, zero-width, byte-order mark), line or paragraph
  separator or lone-surrogate character is refused, so the approval preview shows what is sent; so is any
  `.`, `..` or `.git` segment including the spellings NTFS and HFS fold to it (`.git.`, `.GIT `, `git~1`).
  A request naming a path and a path beneath it (`a` and `a/b`), or one path twice, is refused before any
  request.
- `gitlab_files_get` caps the content of all its files together at 192 KiB: the first file that does
  not fit, and every file after it, is reported with `withheld: "budget"` and no content.

## See also

- [Gitlab Connector Documentation](https://nimbus-agent.dev/user-guide/connectors/)
- [Nimbus Architecture Overview](https://nimbus-agent.dev/architecture-overview/)
- [HITL and Safety](https://nimbus-agent.dev/user-guide/hitl-and-safety/)

## License

AGPL-3.0
