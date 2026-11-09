# Codemagic Connector

## What this is

First-party Nimbus MCP connector for [Codemagic](https://codemagic.io/).
Indexes the user's Codemagic **apps** and recent **builds** into the local
index as `codemagic:app` and `codemagic:build` items and exposes read tools
(`codemagic_list`, `codemagic_get`, `codemagic_search`, `codemagic_build_latest`)
and one owner-approved write tool (`codemagic_build_trigger`).

## Install

Bundled with Nimbus — no separate install required.

## Quickstart

```bash
nimbus vault set codemagic.token <your-codemagic-api-token>
nimbus ask "Which Codemagic builds on main failed in the last 24h?"
```

The Gateway injects `codemagic.token` as `CODEMAGIC_TOKEN` env at spawn
time; the connector itself never touches the vault. The token is sent in
the `x-auth-token` header (Codemagic's API does not use `Authorization`).
The gateway-side syncable
(`packages/gateway/src/connectors/codemagic-sync.ts`) walks
`/apps → /builds?appId=<id>` and upserts each build with metadata
`{ status, workflow_id, app_id, branch, tag, version, started_at,
finished_at, duration_ms, commit }`.

Tools exposed:

| Tool               | Purpose                                                                     |
| ------------------ | --------------------------------------------------------------------------- |
| `codemagic_list`   | List the user's apps, or recent builds for an app (limit optional).         |
| `codemagic_get`    | Fetch a single build by id, or the app list.                                |
| `codemagic_search` | Substring search across recent builds (branch / message / workflow / status). |
| `codemagic_build_latest` | The app's latest build, optionally of one workflow and branch, filtered here from its last 50 builds. |
| `codemagic_build_trigger` | WRITE. `POST /builds`, body `{ appId, workflowId, branch }`, `x-auth-token`. Branch and trigger settings in codemagic.yaml are not applied to an API build. Mutates `codemagic.build.trigger`, recoverable (a build can be cancelled). Scope `app:<appId>`. |

### Write tools

Each write needs the owner's approval (`hitlRequired: ["write"]`). Standalone, set `NIMBUS_MCP_CODEMAGIC_WRITE_SCOPE` to `app:<value>` terms; see `docs/configuration.md`. A write's result says `accepted` and names the id to poll: the vendor runs the work afterwards, and nothing here reports it as finished. A redirect on a write is refused and never followed, so the token is never re-sent anywhere else.

Not verified against a live account: the field names of a build in the `/builds` list (so
`codemagic_build_latest` filters on `workflowId` and `branch` and returns the build as Codemagic
sent it), and the query parameters the builds list accepts. Codemagic says it is transitioning to a
new API. Cancelling a build is not built.

## See also

- [Nimbus Connectors Overview](https://nimbus-agent.dev/user-guide/connectors/)
- [Nimbus Architecture Overview](https://nimbus-agent.dev/architecture-overview/)
- [HITL and Safety](https://nimbus-agent.dev/user-guide/hitl-and-safety/)

## License

AGPL-3.0
