# ArgoCD Connector

## What this is

First-party Nimbus MCP connector for [ArgoCD](https://argo-cd.readthedocs.io/)
GitOps. Indexes the user's **ArgoCD applications** as `argocd:application`
items in the local index and exposes three read-only tools to the Nimbus
agent (`argocd_list`, `argocd_get`, `argocd_search`) plus two HITL-gated
write tools (`argocd_app_sync`, `argocd_app_rollback`). Useful for deployment
correlation — "did this app go OutOfSync / Degraded when the alert fired?".

v1 indexes **applications only** — AppProjects and per-application sync
history are a deferred follow-up.

## Install

Bundled with Nimbus — no separate install required.

## Quickstart

```bash
# ArgoCD is always self-hosted: both keys are required (no defaults).
nimbus vault set argocd.url https://argocd.example.com
nimbus vault set argocd.token <your-argocd-api-token>

nimbus ask "Which ArgoCD applications are OutOfSync right now?"
```

Generate the API token with `argocd account generate-token` (or from the
ArgoCD UI under Settings → Accounts → Tokens). The Gateway injects
`argocd.url` as `ARGOCD_URL` and `argocd.token` as `ARGOCD_TOKEN` at spawn
time; the connector itself never touches the vault. The ArgoCD API token is
sent as the `Authorization: Bearer <token>` header. Because ArgoCD has no
SaaS host, the sandbox network list is empty in the static manifest — the
gateway parses the hostname from `argocd.url` and extends the sandbox network
allow-list at spawn time (`phase3AddArgocdMcp`).

The gateway-side syncable
(`packages/gateway/src/connectors/argocd-sync.ts`) makes a single
`GET /api/v1/applications` call (ArgoCD returns the full list in one
response — no pagination) and upserts each application with metadata
`{ name, namespace, project, sync_status, health_status, repo_url, path,
target_revision, dest_server, dest_namespace, revision, created_at,
canonical_url }`.

Vault keys:

| Key | Required | Purpose |
| --- | --- | --- |
| `argocd.url` | yes | ArgoCD server base URL (e.g. `https://argocd.example.com`); requests go to `${url}/api/v1/...`. |
| `argocd.token` | yes | ArgoCD API token (sent as `Authorization: Bearer <token>`). |

Tools exposed:

| Tool | Purpose |
| --- | --- |
| `argocd_list` | List applications; optional `project` filter + `limit` cap. |
| `argocd_get` | Fetch one application by `name`. |
| `argocd_search` | Substring search across applications (name, project, repo, sync/health status). |
| `argocd_app_sync` | Trigger a sync for an application (`POST /api/v1/applications/{name}/sync`). HITL `argocd.app.sync`; async — verify via the next metadata sync. |
| `argocd_app_rollback` | Roll back an application to a prior deployment history id (`POST /api/v1/applications/{name}/rollback`). HITL `argocd.app.rollback`; async. |

The three list/get/search tools are read-only; the two write tools require
Gateway HITL approval (`hitlRequired` is `["write"]`). The destructive
`argocd.app.delete` write tool is deferred.

## Standalone use

Outside the Nimbus gateway you set `ARGOCD_URL` and `ARGOCD_TOKEN` in the
connector's environment yourself. Its two write tools are offered only to a
client that can show a consent prompt, and each call is checked first against
`NIMBUS_MCP_ARGOCD_WRITE_SCOPE`: comma-separated `app:<application name>`
terms, each matching one application exactly. Unset, it authorises no write.

```json
{
  "mcpServers": {
    "nimbus-argocd": {
      "command": "npx",
      "args": ["-y", "@nimbus-dev/connectors", "argocd"],
      "env": {
        "ARGOCD_URL": "https://argocd.example.com",
        "ARGOCD_TOKEN": "<your-argocd-api-token>",
        "NIMBUS_MCP_ARGOCD_WRITE_SCOPE": "app:web,app:api"
      }
    }
  }
}
```

**Upgrading from 0.2.1 or earlier:** from 0.2.2 the connector reads
`NIMBUS_MCP_ARGOCD_WRITE_SCOPE`; earlier versions read
`NIMBUS_MCP_APP_WRITE_SCOPE` by mistake, so rename it. The value does not
change. The old name is ignored, not read as a fallback: until you rename it,
`argocd_app_sync` and `argocd_app_rollback` refuse every call as out of scope,
and the connector warns at startup that `NIMBUS_MCP_ARGOCD_WRITE_SCOPE` is
unset. Under the Nimbus gateway the write scope is never consulted, so nothing
changes there.

The variables every connector shares — the mutation budget and the audit log —
are in [Configuration](../../docs/configuration.md).

## See also

- [Nimbus Connectors Overview](https://nimbus-agent.dev/user-guide/connectors/)
- [Nimbus Architecture Overview](https://nimbus-agent.dev/architecture-overview/)
- [HITL and Safety](https://nimbus-agent.dev/user-guide/hitl-and-safety/)

## License

AGPL-3.0
