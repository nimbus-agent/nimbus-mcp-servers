# Github Actions Connector

## What this is

First-party Nimbus MCP connector for GitHub Actions. It lets the Nimbus agent list a repository's
workflows and runs, read a run's jobs and a job's console log, and, with owner approval, dispatch a
workflow or cancel a run. Useful for "why did the last build on `main` fail?".

## Install

Bundled with Nimbus — no separate install required.

## Quickstart

GitHub Actions reuses the GitHub connector's personal access token (`github.pat`);
there is no separate GitHub Actions credential, and `nimbus connector auth github-actions`
does not work.

```bash
nimbus connector auth github --token <your-github-pat>
nimbus ask "Summarize my recent activity in Github Actions"
```

The gateway injects the credential as an environment variable at spawn time; the connector itself
never touches the vault.

| Variable | Required | Purpose |
| --- | --- | --- |
| `GITHUB_PAT` | yes | A GitHub personal access token, sent as `Authorization: Bearer <token>`. Read on every call. |
| `GITHUB_API_BASE_URL` | no | The API root. Defaults to `https://api.github.com`. Trailing slashes are stripped. Set it for GitHub Enterprise Server, for example `https://ghe.example.com/api/v3`; the token then goes to that host, so point it only at a server you trust. |

Requests go to the API root with `Accept: application/vnd.github+json` and
`X-GitHub-Api-Version: 2022-11-28`, time out after 15 seconds, and (except the log download below)
pass through the shared redirect guard: a write answered with a redirect is refused rather than
replayed, and a read follows only a same-origin redirect, at most 3 hops. Owner and repository names
must be 1 to 100 characters of letters, digits, `.`, `_` and `-`, and never `.` or `..`; anything else
is refused at the schema.

Tools exposed:

| Tool | Purpose |
| --- | --- |
| `gha_workflow_list` | List a repository's workflows. `perPage` 1 to 100 (default 30), optional `page`. |
| `gha_run_list` | List a repository's workflow runs, optionally filtered by `branch`, `event` and `status` (passed to GitHub as given). `perPage` 1 to 100 (default 30), optional `page`. |
| `gha_run_get` | Get one workflow run by `runId`. |
| `gha_run_jobs` | List the jobs of a run (`runId`). |
| `gha_run_log` | Download a job's console log (`jobId`) and return its last `maxChars` characters (1,000 to 500,000, default 64,000) with `truncated` and `totalChars`. |
| `gha_run_trigger` (write) | Dispatch a workflow (`workflow_dispatch`) by `workflowId` (numeric id or file name such as `ci.yml`), on `ref` (default `main`), with optional string `inputs`. |
| `gha_run_cancel` (write) | Cancel a workflow run by `runId`. |

`gha_run_log` follows the log's redirect by hand: the token is sent to the API host only, and the
redirect target (which must be https, or the API base's own scheme) is fetched without it.

### The writes

Both writes ask for approval (in the gateway, the executor is the gate; standalone, the connector
elicits consent), and both are registered as recoverable.

| Tool | What it changes |
| --- | --- |
| `gha_run_trigger` | `POST .../actions/workflows/{workflowId}/dispatches` with `ref` and `inputs`. Starts a new run; GitHub answers success with no run id, and the tool returns `{ok, owner, repo, workflowId}`. |
| `gha_run_cancel` | `POST .../actions/runs/{runId}/cancel`. |

Standalone, writes are limited by `NIMBUS_MCP_GITHUB_ACTIONS_WRITE_SCOPE`, a comma-separated list of
`kind:value` terms. The one kind is `repo`, with the value `<owner>/<repo>`, for example
`repo:acme/api`. Matching is exact (no prefix match), an unset or empty value denies every write, and
an unknown kind or a term with no colon makes the connector fail at startup.
## See also

- [Nimbus Connectors Overview](https://nimbus-agent.dev/user-guide/connectors/)
- [Nimbus Architecture Overview](https://nimbus-agent.dev/architecture-overview/)
- [HITL and Safety](https://nimbus-agent.dev/user-guide/hitl-and-safety/)

## License

AGPL-3.0
