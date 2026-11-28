# Gitlab Connector

## What this is

First-party Nimbus MCP connector for [GitLab](https://gitlab.com), gitlab.com or a self-hosted
server. It lets the Nimbus agent read projects, merge requests, issues, CI pipelines, jobs and job
logs, and read repository files at a ref. It also offers a set of owner-approved writes: issue and
merge request edits, comments, branches, merge request creation and merge, pipeline retry and
cancel, and a multi-file commit.

## Install

Bundled with Nimbus — no separate install required.

## Quickstart

```bash
nimbus connector auth gitlab
nimbus ask "Summarize my recent activity in Gitlab"
```

The Gateway injects the credential as an environment variable at spawn time; the connector itself
never touches the vault.

| Variable | Required | Purpose |
| --- | --- | --- |
| `GITLAB_PAT` | yes | A GitLab personal access token. REST calls send it as the `PRIVATE-TOKEN` header; the GraphQL calls (the two assignee tools) send it as `Authorization: Bearer`. Read on every call. |
| `GITLAB_API_BASE_URL` | no | The REST base, default `https://gitlab.com/api/v4`; trailing slashes are stripped. For a self-hosted server give its `/api/v4` URL. The GraphQL endpoint is derived from it by dropping a trailing `/api/v4` and appending `/api/graphql`. |

Requests time out after 15 seconds per request. `PRIVATE-TOKEN` is never sent to another origin: a
redirect on a write is refused, and a read follows at most 3 redirects, only to the same origin or
the same host's http -> https upgrade (never https -> http). A plain-http `GITLAB_API_BASE_URL` is
accepted for a self-hosted server; the token is then sent in clear.

Tools exposed:

| Tool | Purpose |
| --- | --- |
| `gitlab_project_list` | List the projects the token is a member of, most recently active first. `perPage` 1-100 (default 30), `page`. |
| `gitlab_mr_list` | List a project's merge requests. `state` (`opened` default, `closed`, `locked`, `merged`, `all`), `perPage` 1-100 (default 30), `page`. |
| `gitlab_mr_get` | Get one merge request by `mergeRequestIid`. |
| `gitlab_mr_merge` (write) | Merge a merge request. Optional `mergeCommitMessage`, `squash`, `shouldRemoveSourceBranch` and `sha` (40 hex): with `sha`, GitLab fails the merge if the source branch head is no longer that commit. |
| `gitlab_issue_list` | List a project's issues. `state` (`opened` default, `closed`, `all`), `perPage` 1-100 (default 30), `page`. |
| `gitlab_issue_get` | Get one issue by `issueIid`. |
| `gitlab_issue_create` (write) | Create an issue: `title` (up to 255), optional `description` (up to 65,000), `labels` (up to 50) and `assigneeIds` (up to 20 numeric user ids). |
| `gitlab_issue_note_create` (write) | Comment on an issue (`body` up to 65,000); nothing else changes. |
| `gitlab_mr_note_create` (write) | Comment on a merge request (`body` up to 65,000); nothing else changes. |
| `gitlab_issue_labels_add` (write) | `PUT .../issues/{iid}` with `add_labels` only: adds, never removes or replaces. 1-50 labels. |
| `gitlab_issue_labels_remove` (write) | `PUT .../issues/{iid}` with `remove_labels` only, so nothing is added or replaced; a label is never deleted from the project. 1-50 labels. |
| `gitlab_issue_assignees_add` (write) | GraphQL `issueSetAssignees` in `APPEND` mode, by username (1-20): adds, removes nobody. |
| `gitlab_issue_assignees_remove` (write) | GraphQL `issueSetAssignees` in `REMOVE` mode, by username (1-20): one server-side removal, so nobody assigned meanwhile is dropped. |
| `gitlab_issue_state_set` (write) | Close or reopen an issue (`stateEvent` `close` or `reopen`); changes only the state. |
| `gitlab_issue_update` (write) | Edit an issue's `title` and/or `description` (at least one). The state, labels and assignees are never touched. |
| `gitlab_branch_create` (write) | Create `branch` from `fromRef` (a branch, tag or commit). With `expectedSha` (40 hex), `fromRef` is resolved first and nothing is created unless it is that commit. |
| `gitlab_mr_create` (write) | Open a merge request from `sourceBranch` into `targetBranch` with `title` and optional `description`, sent as given; no draft, labels or assignees. |
| `gitlab_mr_update` (write) | Edit a merge request's `title`, `description` or `targetBranch` (at least one); it never closes, reopens or merges it. |
| `gitlab_pipeline_list` | List a project's pipelines. Optional `ref` and `status` filters, `perPage` 1-100 (default 30), `page`. |
| `gitlab_pipeline_get` | Get one pipeline by `pipelineId`. |
| `gitlab_pipeline_jobs_get` | List the jobs of a pipeline by `pipelineId`. |
| `gitlab_job_trace` | Download a CI job's whole plain-text trace by `jobId`. |
| `gitlab_job_log_tail` | The same trace, keeping only the last `maxChars` characters (1,000-500,000, default 64,000); reports `truncated` and `totalChars`. |
| `gitlab_pipeline_retry` (write) | Retry the failed jobs of a pipeline (`POST .../pipelines/{id}/retry`). |
| `gitlab_pipeline_cancel` (write) | Cancel a pipeline (`POST .../pipelines/{id}/cancel`). |
| `gitlab_files_get` | Read 1-50 files at a branch, tag or commit: `ref`, `headSha`, and per file `exists`, `lastCommitId`, `executable`, `size` and `content`. A binary or over-192-KiB file is reported with `withheld` instead of content. |
| `gitlab_commit_prepare` | A prepare tool: a read the gateway calls before the commit's approval. Takes the commit's own `projectPath`, `branch` and `files`; returns the branch head and each file's `lastCommitId`, mode and current content. |
| `gitlab_commit_create` (write) | Commit whole text files to a branch as ONE commit, checked against `expectedHeadSha`; never forced. See below. |

Every tool takes `projectPath` as a numeric id or `/`-separated segments of letters, digits, `.`,
`_` and `-`, none of them `.` or `..`; anything else is refused before a request.

### The writes

Every write above is registered through `createWriteToolRegistrar`, so each asks for owner approval.
Standalone, they are limited by `NIMBUS_MCP_GITLAB_WRITE_SCOPE`, a comma-separated list of
`repo:<projectPath>` terms matched exactly against the `projectPath` the call carries (so
`group/project` and a numeric id are different terms); unset or empty denies every write.
`repo` is the only kind.

What each changes, and whether its registration declares it recoverable:

- Recoverable: `gitlab_mr_merge`, `gitlab_issue_create`, `gitlab_issue_note_create`,
  `gitlab_mr_note_create`, `gitlab_issue_labels_add`, `gitlab_issue_labels_remove`,
  `gitlab_issue_assignees_add`, `gitlab_issue_assignees_remove`, `gitlab_issue_state_set`,
  `gitlab_branch_create` (a new branch is undone by deleting it, so nothing is captured first),
  `gitlab_mr_create`, `gitlab_pipeline_retry` and `gitlab_pipeline_cancel`.
- Not recoverable, so the old state is captured first as the audit pre-state: `gitlab_issue_update`
  (old title and description), `gitlab_mr_update` (old title, description and target branch) and
  `gitlab_commit_create` (branch head and each file's last commit id).

Issue edits are each the counterpart of an add-only tool or of `gitlab_mr_update`.
`gitlab_issue_labels_remove` and `gitlab_issue_labels_add` refuse a label containing a comma
(GitLab splits the list on commas). `gitlab_issue_assignees_remove` takes GraphQL's `projectPath`,
which is a full path, so a numeric project id is refused before any request (`gitlab_issue_assignees_add`
accepts a numeric id but GitLab cannot resolve one; give it the full path too).

`gitlab_issue_update` refuses, before the approval prompt and again in the handler, a description
with any line whose first non-space characters are `/` and a letter (`/close`, `/assign @x`): GitLab
runs quick actions in a description, and its docs give no guarantee those are skipped inside a fenced
code block. Wrap the line in backticks to keep it as text. `gitlab_issue_create` (shipped) has no
such check, which is a known bound.

### Multi-file commits

- `gitlab_files_get` reads up to 50 files at a ref (file paths are encoded with
  `encodeURIComponent` and every `.` as `%2E`, as the API page's examples do). `gitlab_commit_prepare`
  returns the branch head and each file's `last_commit_id`, mode and current content;
  `gitlab_commit_create` checks the branch head is still `expectedHeadSha`, reads each existing file at
  that head, and posts ONE commit whose update actions carry that `last_commit_id` (creates carry none),
  never forced. At most 20 files, old plus new content at most 192 KiB, text files only; the commit
  `message` is up to 5,000 characters.
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

- [Nimbus Connectors Overview](https://nimbus-agent.dev/user-guide/connectors/)
- [Nimbus Architecture Overview](https://nimbus-agent.dev/architecture-overview/)
- [HITL and Safety](https://nimbus-agent.dev/user-guide/hitl-and-safety/)

## License

AGPL-3.0
