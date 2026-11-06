# Flagsmith Connector

## What this is

First-party Nimbus MCP connector for [Flagsmith](https://flagsmith.com)
feature flags. Indexes the user's **feature-flag definitions** across all
Flagsmith projects as `flagsmith:feature_flag` items in the local index and
exposes read tools and one owner-approved write tool to the Nimbus agent (`flagsmith_list`,
`flagsmith_get`, `flagsmith_search`, `flagsmith_feature_state_get`, `flagsmith_feature_state_set`). Useful for incident correlation —
"did this flag exist when the alert fired?".

The index holds flag **definitions only** — per-environment on/off state and
segments are read live with `flagsmith_feature_state_get`.

## Install

Bundled with Nimbus — no separate install required.

## Quickstart

```bash
# SaaS (api.flagsmith.com)
nimbus vault set flagsmith.token <your-flagsmith-admin-api-token>

# Self-hosted / regional
nimbus vault set flagsmith.api_base https://flagsmith.internal.example.com

nimbus ask "Which Flagsmith feature flags are archived in the payments project?"
```

The Gateway injects `flagsmith.token` as `FLAGSMITH_TOKEN` (and the optional
`flagsmith.api_base` as `FLAGSMITH_API_BASE`) at spawn time; the connector
itself never touches the vault. The Flagsmith admin API token is sent as the
`Authorization: Token <token>` header (the literal word `Token`, a space, then
the raw token — not `Bearer`). The gateway-side syncable
(`packages/gateway/src/connectors/flagsmith-sync.ts`) walks
`GET /api/v1/projects/ → GET /api/v1/projects/{id}/features/` (DRF-paged
100/page, capped 20 pages per project) plus one
`GET /api/v1/projects/{id}/tags/` call per project to resolve tag ids to
labels, and upserts each flag with metadata
`{ name, type, default_enabled, initial_value, description, tags, is_archived,
owner_count, project_id, project_name, created_at, canonical_url }`.

Vault keys:

| Key | Required | Purpose |
| --- | --- | --- |
| `flagsmith.token` | yes | Flagsmith admin API token (sent as `Authorization: Token <token>`). |
| `flagsmith.api_base` | no | Regional / self-hosted host root (default `https://api.flagsmith.com`); requests go to `${api_base}/api/v1/...`. |

Tools exposed:

| Tool | Purpose |
| --- | --- |
| `flagsmith_list` | List projects (no `projectId`), or feature flags for a project. |
| `flagsmith_get` | Fetch one flag by `projectId` + `featureName` (search + exact-name narrow). |
| `flagsmith_search` | Substring search across a project's flags (name, description, tags). |

| `flagsmith_feature_state_get` | Read one feature in ONE environment: `environment_default` and `segment_overrides` (capped at 50, the rest counted). |
| `flagsmith_feature_state_set` (write) | Enable or disable a feature in ONE environment, optionally with a typed value (`string`, `integer` or `boolean`, value sent as a string). Segment and identity overrides are untouched. |

`flagsmith_feature_state_set` declares `hitlRequired: ["write"]` and records the previous state
before it writes. Outside the gateway, scope it with
`NIMBUS_MCP_FLAGSMITH_WRITE_SCOPE=flag:<environmentKey>/<featureId>`.

### Which endpoint, and why

The two state tools use Flagsmith's **experimental** `GET`/`PATCH
/api/__future__/environments/{environment_key}/features/{feature_id}/` ("may change without
notice", <https://docs.flagsmith.com/managing-flags/updating-flags>). The v1 environment
feature-state endpoints (`/api/v1/environments/{key}/featurestates/{id}/`) are still in the
published swagger, but Flagsmith's own repository calls them "deprecated" (PR 8732, "the legacy
feature state APIs"), the docs site documents only the `__future__` pair, and the v1 write needs a
feature-state id looked up first. The path is built in one place (`apiFuture` in `src/tools.ts`), so
a change is one edit. Flagsmith refuses the write while change requests are enabled for the
environment; its message is returned as is. Omitting `value` is intended to leave the stored value
alone, but how the `__future__` PATCH merges a partial `environment_default` is unverified against a
live server. The result carries `confirmed`, true only when the reply shows the requested `enabled`.

Authentication: the state tools send the same `Authorization: Token <token>` header as the reads.
The swagger lists that scheme (`tokenAuth`) on the `__future__` operations; the docs page shows
`Api-Key`, the organisation master-key scheme. Unverified against a live key: if a token is
rejected, `flagsmithHeaders` is the one line to change. Redirects are never followed to another
origin.

## See also

- [Nimbus Connectors Overview](https://nimbus-agent.dev/user-guide/connectors/)
- [Nimbus Architecture Overview](https://nimbus-agent.dev/architecture-overview/)
- [HITL and Safety](https://nimbus-agent.dev/user-guide/hitl-and-safety/)

## License

AGPL-3.0
