# Vercel Connector

## What this is

First-party Nimbus MCP connector for [Vercel](https://vercel.com). Indexes the
user's recent **deployments** as `vercel:deployment` items in the local index
and exposes read tools (`vercel_list`, `vercel_get`, `vercel_search`,
`vercel_project_production_get`) and two owner-approved write tools
(`vercel_deployment_redeploy`, `vercel_deployment_promote`). Useful for correlating deploys with PR / Slack
history — "which deploy shipped this commit?".

## Install

Bundled with Nimbus — no separate install required.

## Quickstart

```bash
nimbus vault set vercel.token <your-vercel-access-token>
nimbus ask "What was the last production deploy on Vercel?"
```

The Gateway injects `vercel.token` as `VERCEL_TOKEN` (and the optional
`vercel.team_id` as `VERCEL_TEAM_ID`) at spawn time; the connector itself never
touches the vault. The gateway-side syncable
(`packages/gateway/src/connectors/vercel-sync.ts`) walks
`GET /v6/deployments?limit=100` (paginated via `pagination.next`, capped 20
pages) and upserts each deployment with metadata `{ uid, name, state, target,
url, inspector_url, commit_sha, commit_message, commit_ref, pr_id, repo,
creator, created_at, canonical_url }`.

Vault keys:

| Key | Required | Purpose |
| --- | --- | --- |
| `vercel.token` | yes | Vercel access token (sent as `Authorization: Bearer <token>`). |
| `vercel.team_id` | no | Scope requests to a team — appended as `teamId=<id>` on every request. |

The API host is fixed at `https://api.vercel.com` (no host override key — it is
a SaaS host).

Tools exposed:

| Tool | Purpose |
| --- | --- |
| `vercel_list` | List recent deployments (`GET /v6/deployments`). |
| `vercel_get` | Fetch one deployment by id or `*.vercel.app` URL (`GET /v13/deployments/{idOrUrl}`). |
| `vercel_search` | Substring search across recent deployments (uid, name, state, target, url, commit message). |
| `vercel_project_production_get` | The project's current production deployment (`GET /v9/projects/{id}`, `targets.production`). What a promote replaces. |
| `vercel_deployment_redeploy` | WRITE. `POST /v13/deployments?forceNew=1`, body `{ name, deploymentId, target, withLatestCommit? }`. `target` is always sent (`production` or `preview`): omitting it makes a preview. `name` is read from the source deployment first; an unknown deployment sends nothing. Mutates `vercel.deployment.redeploy`; not recoverable (a production redeploy can supersede what is live), source deployment audited. Scope `deployment:<deploymentId>`. |
| `vercel_deployment_promote` | WRITE. `POST /v10/projects/{projectId}/promote/{deploymentId}`, no body; promotes WITHOUT rebuilding. Mutates `vercel.deployment.promote`; not recoverable, the current production deployment is audited first. Scope `project:<projectId>`. |

### Write tools

Each write needs the owner's approval (`hitlRequired: ["write"]`). Standalone, set `NIMBUS_MCP_VERCEL_WRITE_SCOPE` to `project|deployment:<value>` terms; see `docs/configuration.md`. A write's result says `accepted` and names the id to poll: the vendor runs the work afterwards, and nothing here reports it as finished. A redirect on a write is refused and never followed, so the token is never re-sent anywhere else.

Not verified against a live account (documented in Vercel's OpenAPI, not in fixtures): which token
scope a promote needs, and that `target: "preview"` is accepted by a redeploy. Rollback
(`POST /v1/projects/{id}/rollback/...`) is not built. The `vercel_list` read still uses `/v6/deployments`.
Projects, domains, environment variables, aliases, and build logs are deferred follow-ups.

## See also

- [Nimbus Connectors Overview](https://nimbus-agent.dev/user-guide/connectors/)
- [Nimbus Architecture Overview](https://nimbus-agent.dev/architecture-overview/)
- [HITL and Safety](https://nimbus-agent.dev/user-guide/hitl-and-safety/)

## License

AGPL-3.0
