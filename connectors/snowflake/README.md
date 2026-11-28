# Snowflake Connector

## What this is

First-party Nimbus MCP connector for [Snowflake](https://www.snowflake.com/).
Indexes the user's **Snowflake tables** as `snowflake:data_model` items in the
local index and exposes three read-only tools to the Nimbus agent
(`snowflake_list`, `snowflake_get`, `snowflake_search`) plus two HITL-gated
governance write tools (`snowflake_tag_set`, `snowflake_comment_set`). Indexes
column names and tags only — **NEVER row data or cell values**.

Uses the Snowflake SQL REST API (`POST /api/v2/statements`) with OAuth token
or key-pair JWT auth. v1 indexes tables from `information_schema.tables` across
all non-INFORMATION_SCHEMA schemas. `snowflake_list` and `snowflake_get` also return each
table's `columns` (`{ name, type, nullable, ordinal }`, from `information_schema.columns`, one
query per schema, capped at 20,000 columns per schema and 50 schemas per page;
`columns_complete` is false when a cap or a failed query may have cut them). Never a column
default, comment or any row data.

## Install

Bundled with Nimbus — no separate install required.

## Quickstart

```bash
# OAuth token flow:
nimbus vault set snowflake.account acme-xy12345
nimbus vault set snowflake.oauth_token <your-oauth-token>

# Or key-pair JWT flow:
nimbus vault set snowflake.account acme-xy12345
nimbus vault set snowflake.key_pair_jwt <your-jwt>

nimbus ask "Which Snowflake tables contain revenue data?"
```

The account identifier is the part before `.snowflakecomputing.com`
(e.g. `acme-xy12345`). The gateway injects `SNOWFLAKE_ACCOUNT` and
`SNOWFLAKE_TOKEN` at spawn time; the connector itself never touches the vault.
Because Snowflake accounts have unique hostnames, the sandbox network list is
empty in the static manifest — the gateway derives the hostname from
`snowflake.account` and extends the sandbox network allow-list at spawn time
(`phase3AddSnowflakeMcp`).

The gateway-side syncable
(`packages/gateway/src/connectors/snowflake-sync.ts`) posts one
`/api/v2/statements` query to `information_schema.tables`, then upserts each
table as a `data_model` item with metadata `{ dataModelKey, columns,
rowCountEstimate, lastAltered }`. The `dataModelKey` is a normalized
`database.schema.table` identifier shared across all Slice-7 warehouse
connectors so cross-connector lineage edges converge on one graph node.

Vault keys:

| Key | Required | Purpose |
| --- | --- | --- |
| `snowflake.account` | yes | Snowflake account identifier (e.g. `acme-xy12345`); requests go to `https://${account}.snowflakecomputing.com`. |
| `snowflake.oauth_token` | one of | OAuth access token (sent as `Authorization: Bearer`). |
| `snowflake.key_pair_jwt` | one of | Key-pair JWT (sent as `Authorization: Bearer`). |

Tools exposed:

| Tool | Purpose |
| --- | --- |
| `snowflake_list` | List tables with their columns; optional `cursor` and `limit` (default 200, max 500); returns `{ items, nextCursor }`. |
| `snowflake_get` | Fetch one table by fully-qualified id (`database.schema.table`). |
| `snowflake_search` | Substring search across tables (name, schema, database). |
| `snowflake_object_metadata_get` | Read a table's or view's comment and tags (direct and inherited); see Behaviour notes. |
| `snowflake_tag_set` | Set or unset a governance TAG on a table (`ALTER TABLE <object> SET TAG <tag> = '<value>'`; omit `value` to UNSET). HITL-gated. |
| `snowflake_comment_set` | Set a COMMENT on a table (`COMMENT ON TABLE <object> IS '<comment>'`). HITL-gated. |

The three list/get/search tools are read-only; the two governance write tools
require Gateway HITL approval (`hitlRequired` is `["write"]`). Column
statistics and query history are deferred.

### The writes

Both go through the consent registrar. Outside the gateway each is gated by owner consent, a
write-scope allow-list, a mutation budget and an audit record; in the gateway the executor is the
gate. Scope them with `NIMBUS_MCP_SNOWFLAKE_WRITE_SCOPE`, a comma-separated list of `kind:value`
terms with exact matching. One kind exists, `object:<fully qualified name>`, matched against the
`object` argument exactly as the caller wrote it (no case folding or quoting normalisation). An
unset or empty scope refuses every write, and an unknown kind fails at startup. Both tools reject
an `object` or `tag` that is not a valid identifier before running any statement.

| Tool | Changes | Recoverable |
| --- | --- | --- |
| `snowflake_tag_set` | Sets a governance tag on a table (`ALTER TABLE ... SET TAG`), or unsets it when `value` is omitted. | `true` |
| `snowflake_comment_set` | Replaces a table's comment (`COMMENT ON TABLE ... IS`). | `true` |

`snowflake_object_metadata_get` reads a table's or view's comment and tags, the before-state of
both writes.

## Behaviour notes

- Requests go through `guardedFetch`, so the Bearer token never follows a redirect and a redirect on a
  statement is refused.
- `snowflake_object_metadata_get {objectType?: "table"|"view", object: "db.schema.name"}` returns
  `{object, objectType, comment, tags:[{database, schema, name, value}]}` (metadata only, never row
  data; `database` and `schema` are where the tag itself lives, so two tags of one name in different
  schemas stay apart, and the tags are sorted by that qualified name, then value) from two live
  statements: `SHOW TABLES|VIEWS LIKE ... IN SCHEMA` and `INFORMATION_SCHEMA.TAG_REFERENCES` (never
  `ACCOUNT_USAGE`, which lags up to 120 minutes). The SHOW page documents no way to escape the LIKE
  wildcards `%` and `_`, so the pattern only narrows the rows and the object is picked by exact name
  in code. Live check: `TAG_REFERENCES` freshness right after a `SET TAG`.

## See also

- [Nimbus Connectors Overview](https://nimbus-agent.dev/user-guide/connectors/)
- [Nimbus Architecture Overview](https://nimbus-agent.dev/architecture-overview/)
- [HITL and Safety](https://nimbus-agent.dev/user-guide/hitl-and-safety/)

## License

AGPL-3.0
