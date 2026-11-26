# Bitbucket Connector

MCP server for Bitbucket Cloud (REST API 2.0), run over stdio by any MCP client.

## Tools

| Tool | Kind | What it does |
| --- | --- | --- |
| `bitbucket_repo_list` | read | Repositories where the authenticated user is a member. |
| `bitbucket_pr_list` | read | Pull requests of a repository, optionally by state. |
| `bitbucket_pr_get` | read | One pull request by numeric id. |
| `bitbucket_pipeline_list` | read | Pipelines runs of a repository. |
| `bitbucket_pipeline_get` | read | One pipeline run by UUID. |
| `bitbucket_issue_list` | read | Issues of a repository (the issue tracker must be enabled). |
| `bitbucket_pr_merge` | write | Merge a pull request. |
| `bitbucket_pr_comment_create` | write | Comment on a pull request; inline on `path` (and `line`) when given. `line` needs `path`. |

Repositories are named `workspace/repo_slug`.

## Credentials

Both come from the environment at startup:

- `BITBUCKET_USERNAME`
- `BITBUCKET_APP_PASSWORD`

A tool call without them fails by naming the missing variable.

## Write scope

Outside the Nimbus gateway, every write tool asks for consent and is limited to the targets in
`NIMBUS_MCP_BITBUCKET_WRITE_SCOPE`. The scope kind is `repo`, and a term is `kind:value`, for example
`repo:myteam/my-service` (a `workspace/repo_slug` full name, matched exactly). Unset authorises
nothing. See the repository's `docs/configuration.md` for the syntax and the mutation budget.

## License

AGPL-3.0-only
