# Github Connector

## What this is

First-party Nimbus MCP connector for GitHub. It gives the Nimbus agent the repositories, pull
requests, issues, branches, commits and workflow runs the token can see, and a set of owner-approved
write tools (merge, comment, label, assign, edit, review, branch, tag and multi-file commit). Useful
for questions like "what is open against `main` and is CI green on it?", and for acting on the
answer.

## Install

Bundled with Nimbus — no separate install required.

## Quickstart

```bash
nimbus connector auth github
nimbus ask "Summarize my recent activity in Github"
```

The gateway injects the credential as an environment variable at spawn time; the connector itself
never touches the vault. The `github-actions` connector reads the same two variables.

| Variable | Required | Purpose |
| --- | --- | --- |
| `GITHUB_PAT` | yes | A GitHub personal access token, sent as `Authorization: Bearer <token>` on every request. Read on every call. |
| `GITHUB_API_BASE_URL` | no | The API root. Defaults to `https://api.github.com`. Trailing slashes are stripped. Set it for GitHub Enterprise Server, see below. |

Requests go to the API root with `Accept: application/vnd.github+json` and
`X-GitHub-Api-Version: 2022-11-28`, time out after 15 seconds, and pass through the shared redirect
guard: a write that GitHub answers with a redirect (a renamed or transferred repository) is refused
rather than replayed, and a read follows only a same-origin redirect, at most 3 hops, so the token
never travels to another origin. Owner and repository names must be 1 to 100 characters of letters,
digits, `.`, `_` and `-`, and never `.` or `..`; the `ref` of the ref, commit and file-read tools, and
the `branch` and `fromRef` of branch create and file commit, must pass a safe git ref check. Anything
else is refused at the schema, before a request.

Tools exposed:

| Tool | Purpose |
| --- | --- |
| `github_repo_list` | List the authenticated user's repositories (owner, collaborator, organization member), most recently updated first. `perPage` 1 to 100 (default 30), optional `page`. |
| `github_repo_get` | Get one repository's metadata by `owner` and `repo`. |
| `github_pr_list` | List a repository's pull requests, most recently updated first. `state` is `open` (default), `closed` or `all`; `perPage` 1 to 100 (default 30), optional `page`. |
| `github_pr_get` | Get one pull request by `pullNumber`. |
| `github_pr_merge` (write) | Merge a pull request, optionally with `mergeMethod` (`merge`, `squash`, `rebase`), `commitTitle` (at most 500 characters) and `sha`, the head sha it must match. |
| `github_pr_close` (write) | Close a pull request without merging it. |
| `github_issue_list` | List a repository's issues, same `state`, paging and ordering as `github_pr_list`. |
| `github_issue_get` | Get one issue by `issueNumber`. |
| `github_issue_create` (write) | Create an issue: `title` (1 to 500 characters), optional `body` (at most 65,000). |
| `github_issue_comment_create` (write) | Comment on an issue or a pull request's conversation: `body` 1 to 65,000 characters. Posts as the authenticated user. |
| `github_issue_labels_add` (write) | Add 1 to 100 labels (each at most 50 characters) to an issue or pull request; a label that does not exist is created. Only adds. |
| `github_issue_assignees_add` (write) | Add 1 to 10 assignee logins to an issue or pull request. Only adds. |
| `github_issue_state_set` (write) | Set an issue's `state` to `open` or `closed`; given a pull request number it closes or reopens the pull request. |
| `github_issue_labels_remove` (write) | Remove 1 to 100 distinct labels from an issue or pull request, one `DELETE` per label in order. |
| `github_issue_assignees_remove` (write) | Remove 1 to 10 assignee logins from an issue or pull request. |
| `github_issue_update` (write) | Edit an issue's or pull request's `title` and/or `body` (at least one). |
| `github_pr_review_create` (write) | Submit a review: `body`, `event` and up to 50 inline `comments`. `event` is `COMMENT` or `REQUEST_CHANGES` only. |
| `github_ci_runs` | List a repository's GitHub Actions workflow runs (`perPage` 1 to 100, default 30, optional `page`). |
| `github_ci_run_get` | Get one workflow run by `runId`. |
| `github_branch_delete` (write) | Delete a branch (`heads/<branch>`). |
| `github_ref_get` | Resolve a branch, tag or commit to its commit sha: `{ref, kind: branch\|tag\|sha, sha}`. A bare name is tried as a branch, then a tag; an annotated tag resolves to its commit. |
| `github_commit_get` | Get one commit by `repoFull` (`owner/repo`) and `ref`: sha, first line of the message (at most 200 characters), author name and date, parent shas. |
| `github_branch_create` (write) | Create a branch from `fromRef`; if `expectedSha` is given and `fromRef` now resolves elsewhere, nothing is created. |
| `github_pr_create` (write) | Open a pull request from `head` into `base` with `title` (1 to 256 characters), optional `body` and `draft`. |
| `github_pr_update` (write) | Edit a pull request's `title`, `body` and/or `base` (at least one). |
| `github_tag_create` (write) | Create a lightweight tag `tag` pointing at commit `sha` (7 to 40 characters). |
| `github_commit_push` | A stub: it returns `NOT_IMPLEMENTED` and does nothing. Push with local git. |
| `github_files_get` | Read 1 to 50 files at a `ref`: `{ref, headSha, files}` with mode, blob sha, size and content for text files. |
| `github_commit_prepare` | A prepare tool: a read the gateway calls before the approval prompt for `github_file_commit`. Returns the branch head and each file's current state. |
| `github_file_commit` (write) | Commit whole text files to a branch as ONE commit, only if the branch head is still `expectedHeadSha`. |

Pull requests are issues to GitHub, so the label, assignee, comment, state and update tools take a
pull request's number as `issueNumber`.

## GitHub Enterprise Server

Set `GITHUB_API_BASE_URL` to the server's API root, for example `https://ghe.example.com/api/v3`, and
the `github` and `github-actions` connectors send every request there instead of `api.github.com`.
`GITHUB_PAT` goes to that host, so point it only at a server you trust. Standalone, add the host to
your sandbox or network allow-list yourself; the manifest lists `api.github.com`, `uploads.github.com`
and `raw.githubusercontent.com`.

## The writes

Every write asks for approval (in the gateway, the executor is the gate; standalone, the connector
elicits consent). Standalone, a write is limited by `NIMBUS_MCP_GITHUB_WRITE_SCOPE`, a comma-separated
list of `kind:value` terms. The one kind is `repo`, and the value is `<owner>/<repo>`, for example
`repo:acme/api,repo:acme/web`. Matching is exact (no prefix: `acme/api` does not allow
`acme/api-secrets`), an unset or empty value denies every write, and an unknown kind or a term with no
colon makes the connector fail at startup. The connector's instructions state that standalone, mutating
tools are not listed, and are refused, if the client does not support elicitation.

"Recoverable" below is what each tool's registration declares. A tool registered as not recoverable
has its before-state recorded first in the audit record.

| Tool | What it changes | Recoverable |
| --- | --- | --- |
| `github_pr_merge` | Merges the pull request. `sha` is sent as the merge endpoint's `sha` parameter only when given; GitHub's 409 is then reported as "nothing was merged". | yes |
| `github_pr_close` | Sets the pull request's state to closed. | yes |
| `github_issue_create` | Creates an issue. | yes |
| `github_issue_comment_create` | Adds a comment; changes nothing else. | yes |
| `github_issue_labels_add` | Adds labels; cannot remove or replace any. | yes |
| `github_issue_assignees_add` | Adds assignees; cannot remove any. | yes |
| `github_issue_state_set` | Changes only the state. | yes |
| `github_issue_labels_remove` | One `DELETE .../issues/{n}/labels/{name}` per label, in order; a name is URL-encoded and `.` or `..` is refused. It stops at the first refusal (a label not on the issue is a 404) and names the labels already removed. The repository's labels are never deleted. | yes |
| `github_issue_assignees_remove` | `DELETE .../issues/{n}/assignees` with the logins named; a login not assigned is ignored by GitHub. | yes |
| `github_issue_update` | `PATCH .../issues/{n}` with `title` and/or `body`; refused before the approval prompt when neither is given. The old title and body are recorded first. | no |
| `github_pr_review_create` | `POST .../pulls/{n}/reviews`. `event` is `COMMENT` or `REQUEST_CHANGES` only: `APPROVE` is refused at the schema, because an approval can satisfy branch protection. Each inline comment has `path`, `line`, optional `side` (`LEFT` or `RIGHT`) and `startLine`; one whose `startLine` is not below its `line` is refused before the prompt. An optional `commitId` (a full 40-hex sha, sent as `commit_id`) pins the review to the commit that was approved; without it the review lands on the current head. A submitted review cannot be deleted, so the pull request's head sha and state are recorded first. | no |
| `github_branch_delete` | Deletes the branch. The ref's sha is recorded first, so the branch can be recreated. | no |
| `github_branch_create` | Creates `refs/heads/<branch>` at the commit `fromRef` resolves to (optionally pinned with `expectedSha`, so a branch that moved after approval is refused). Undone by `github_branch_delete`. | yes |
| `github_pr_create` | Opens a pull request; title and body are sent verbatim, and it is a draft only when `draft` is true. `head` may be `user:branch` for a fork. | yes |
| `github_pr_update` | Edits title, body or base only; never opens, closes or merges. The old values are recorded first. | no |
| `github_tag_create` | Creates `refs/tags/<tag>` at `sha`. | yes |
| `github_file_commit` | See below. | no |

A fine-grained token needs Issues: write for the label, assignee and issue edits (Pull requests:
write for a pull request's), and Pull requests: write for a review. For branches and pull requests,
it needs Contents: write for branch create and Pull requests: write for PR create and update.

## Behaviour notes

- Multi-file commits: `github_files_get` reads up to 50 files at a ref; `github_commit_prepare` (a prepare
  tool, see the architecture doc) returns the branch head and each file's current state for the owner to
  approve; `github_file_commit` commits whole text files as ONE commit through the Git Data API
  (blobs, a tree on the head's tree, a commit whose only parent is the head, then a ref update with
  `force: false`) and only when the branch head is still `expectedHeadSha`. At most 20 files, and the old
  plus new content at most 192 KiB (the prepare refuses rather than truncates). The commit `message` is
  1 to 5,000 characters. Text files only: no deletes, no mode changes, and a symlink, submodule or binary
  file is refused. Existing files keep their mode, new ones are `100644`. Bounds, each a live-check item:
  the status and message of a non-fast-forward ref update (the page lists only 409 and 422, and any of
  them is surfaced as "head moved or ref update refused"), whether API commits made with a token are
  signed, and the status of a ref update refused by branch protection (surfaced verbatim).
- In standalone mode a prepare tool is registered for every client, since it prompts no one. It sits
  behind the same `NIMBUS_MCP_GITHUB_WRITE_SCOPE` as the writes it serves and spends no write budget.
- Paths: a file path with a control, format (bidi, zero-width, byte-order mark), line or paragraph
  separator or lone-surrogate character is refused, so the approval preview shows what is sent; so is any
  `.`, `..` or `.git` segment including the spellings NTFS and HFS fold to it (`.git.`, `.GIT `, `git~1`).
  A request naming a path and a path beneath it (`a` and `a/b`), or one path twice, is refused before any
  request.
- `github_files_get` caps the content of all its files together at 192 KiB: the first file that does
  not fit, and every file after it, is reported with `withheld: "budget"` and no content. A binary,
  symlink, submodule or over-192-KiB file is reported with its sha and `withheld` instead of content.
- `github_pr_merge` takes an optional `sha` (40 lowercase hex): the head SHA the pull request must match.
  It is sent as the merge endpoint's documented `sha` parameter only when given, and GitHub's 409
  ("Conflict if sha was provided and pull request head did not match") is reported as a clear error saying
  nothing was merged. The page documents the field and the 409; it gives no example message text.
- `github_commit_get {repoFull: "owner/repo", ref}` returns `{sha, message (first line, at most 200
  characters), authorName, authorDate, parents}`, the before-state of `github_tag_create`. `ref` is a sha
  (full or abbreviated), `heads/<branch>`, `tags/<tag>`, or a bare name tried as a branch and then a tag. A
  404, or a 422 "No commit found", is "commit not found".

## See also

- [Nimbus Connectors Overview](https://nimbus-agent.dev/user-guide/connectors/)
- [Nimbus Architecture Overview](https://nimbus-agent.dev/architecture-overview/)
- [HITL and Safety](https://nimbus-agent.dev/user-guide/hitl-and-safety/)

## License

AGPL-3.0
