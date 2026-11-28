# Bigeye Connector

## What this is

First-party Nimbus MCP connector for [Bigeye](https://www.bigeye.com/).
Indexes the user's **Bigeye data-quality issues** as `data_quality_test` items in the
local index and exposes three read-only tools to the Nimbus agent
(`bigeye_list`, `bigeye_get`, `bigeye_search`) plus two HITL-gated
issue-lifecycle write tools (`bigeye_issue_acknowledge`, `bigeye_issue_resolve`). Indexes issue metadata and
monitored table names for cross-connector lineage — **NEVER row data or cell values**.

Uses a Bearer API key against a per-tenant Bigeye instance (`base_url`).
The per-tenant host is derived from `bigeye.base_url` at spawn time (like
the Looker/Tableau/Snowflake connectors).

## Install

Bundled with Nimbus — no separate install required.

## Quickstart

```bash
nimbus vault set bigeye.base_url https://app.bigeye.com
nimbus vault set bigeye.api_key <your-bigeye-api-key>

nimbus ask "Which tables have active Bigeye data-quality breaches?"
```

The gateway injects `BIGEYE_BASE_URL` and `BIGEYE_API_KEY` at spawn time via
`phase3AddBigeyeMcp`; the connector itself never touches the vault.

The gateway-side syncable
(`packages/gateway/src/connectors/bigeye-sync.ts`) lists issues via
`GET /api/v1/issues`, then upserts each issue as a `data_quality_test` item
with metadata `{ monitoredDataModelKeys, slaStatus, anomaly }`.

Vault keys:

| Key | Required | Purpose |
| --- | --- | --- |
| `bigeye.base_url` | yes | Per-tenant Bigeye instance URL (e.g. `https://app.bigeye.com`). |
| `bigeye.api_key` | yes | Bigeye API key (Bearer token). |

Tools exposed:

| Tool | Purpose |
| --- | --- |
| `bigeye_list` | List Bigeye data-quality issues; optional `limit` cap (default 200, max 500). |
| `bigeye_get` | Fetch one issue by id. |
| `bigeye_search` | Substring search across issues by summary, title and description. |
| `bigeye_issue_acknowledge` | Acknowledge a Bigeye issue. HITL-gated. |
| `bigeye_issue_resolve` | Resolve (close) a Bigeye issue. HITL-gated. |

The three list/get/search tools are read-only; the two write tools require
Gateway HITL approval (`hitlRequired` is `["write"]`).

### The writes

Both write tools go through the consent registrar and are declared `recoverable: true`, so neither
has a `capturePreState`: an issue's status can be set again. Outside the gateway each is gated by
owner consent, a write-scope allow-list, a mutation budget and an audit record; in the gateway the
executor is the gate.

| Tool | Changes | Recoverable | Scope target |
| --- | --- | --- | --- |
| `bigeye_issue_acknowledge` | Sets one issue's status to `ISSUE_STATUS_ACKNOWLEDGED` (`POST /api/v1/issues`). | `true` | `issue:<issueId>` |
| `bigeye_issue_resolve` | Sets one issue's status to `ISSUE_STATUS_CLOSED` (`POST /api/v1/issues`). | `true` | `issue:<issueId>` |

Scope them with `NIMBUS_MCP_BIGEYE_WRITE_SCOPE`, a comma-separated list of `kind:value` terms matched
exactly. The only kind is `issue`, matched against the `issueId` argument; an unknown kind fails at
startup, and an unset or empty scope refuses every write.

## See also

- [Nimbus Connectors Overview](https://nimbus-agent.dev/user-guide/connectors/)
- [Nimbus Architecture Overview](https://nimbus-agent.dev/architecture-overview/)
- [HITL and Safety](https://nimbus-agent.dev/user-guide/hitl-and-safety/)

## License

AGPL-3.0
