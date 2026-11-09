# Bitrise Connector

## What this is

First-party Nimbus MCP connector for [Bitrise](https://www.bitrise.io/).
Indexes the user's Bitrise **apps** and recent **builds** into the local
index as `bitrise:app` and `bitrise:build` items and exposes read tools
(`bitrise_list`, `bitrise_get`, `bitrise_search`, `bitrise_build_latest`) and one
owner-approved write tool (`bitrise_build_trigger`).

## Install

Bundled with Nimbus — no separate install required.

## Quickstart

```bash
nimbus vault set bitrise.token <your-bitrise-personal-access-token>
nimbus ask "Which Bitrise builds on main failed in the last 24h?"
```

The Gateway injects `bitrise.token` as `BITRISE_TOKEN` env at spawn time;
the connector itself never touches the vault. The gateway-side syncable
(`packages/gateway/src/connectors/bitrise-sync.ts`) walks
`/v0.1/me/apps → /v0.1/apps/<slug>/builds` and upserts each build with
metadata `{ status, workflow_id, app_slug, started_at, finished_at,
duration_ms, triggered_by, commit_hash, branch }`.

Tools exposed:

| Tool             | Purpose                                                                       |
| ---------------- | ----------------------------------------------------------------------------- |
| `bitrise_list`   | List the user's apps, or recent builds for an app (status filter + limit).    |
| `bitrise_get`    | Fetch a single app or build by slug.                                          |
| `bitrise_search` | Substring search across recent builds (branch / commit / workflow / status). |
| `bitrise_build_latest` | The app's latest build, optionally of one branch and workflow (the list tool has no such filter). |
| `bitrise_build_trigger` | WRITE. `POST /v0.1/apps/{appSlug}/builds`, body `{ hook_info: { type: "bitrise" }, build_params: { branch, workflow_id } }`; the token is sent raw in `Authorization`, no Bearer. The build slug is read from `build_slug` at the root, then `slug`, then `results[0].build_slug` (never the deprecated `build_url`). Mutates `bitrise.build.trigger`, recoverable (a build can be aborted). Scope `app:<appSlug>`. |

### Write tools

Each write needs the owner's approval (`hitlRequired: ["write"]`). Standalone, set `NIMBUS_MCP_BITRISE_WRITE_SCOPE` to `app:<value>` terms; see `docs/configuration.md`. A write's result says `accepted` and names the id to poll: the vendor runs the work afterwards, and nothing here reports it as finished. A redirect on a write is refused and never followed, so the token is never re-sent anywhere else.

Not verified against a live account: which of the three slug fields a current reply carries (the
swagger marks `build_slug` deprecated beside `slug`). Aborting a build is not built.

## See also

- [Nimbus Connectors Overview](https://nimbus-agent.dev/user-guide/connectors/)
- [Nimbus Architecture Overview](https://nimbus-agent.dev/architecture-overview/)
- [HITL and Safety](https://nimbus-agent.dev/user-guide/hitl-and-safety/)

## License

AGPL-3.0
