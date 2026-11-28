# Notion Connector

## What this is

First-party Nimbus MCP connector for Notion. Exposes the pages, databases, blocks and comments the
integration can access to the Nimbus agent (`notion_page_list`, `notion_page_get`,
`notion_database_list`, `notion_database_query`, `notion_block_children`, `notion_comment_list`),
plus five owner-approved write tools (`notion_page_create`, `notion_kb_append`,
`notion_page_update`, `notion_block_append`, `notion_comment_create`). Useful for answering
questions from a team's notes and for writing results back to them.

Indexes and provides context from Notion to the Nimbus agent.

## Install

Bundled with Nimbus — no separate install required.

## Quickstart

```bash
nimbus connector auth notion
nimbus ask "Summarize my recent activity in Notion"
```

The gateway injects the credential as an environment variable at spawn time; the connector itself
never touches the vault. It is read on every call.

| Variable | Required | Purpose |
| --- | --- | --- |
| `NOTION_ACCESS_TOKEN` | yes | The Notion access token, sent as `Authorization: Bearer <token>`. There is no default. |

Requests go to `https://api.notion.com/v1/...` with `Notion-Version: 2022-06-28`. The host is fixed
in code, not configurable. Non-2xx answers are reported with Notion's own body.

Tools exposed:

| Tool | Purpose |
| --- | --- |
| `notion_page_list` | Search the pages the integration can access (`POST /v1/search`, object filter `page`). Optional `query`, `pageSize` 1 to 100 (default 50), `startCursor`. |
| `notion_page_get` | Retrieve a page by `pageId` together with its direct child blocks (first 100). |
| `notion_database_list` | Search databases (`POST /v1/search`, object filter `database`); same arguments as `notion_page_list`. |
| `notion_database_query` | Query a database by `databaseId` (`POST /v1/databases/{id}/query`), `pageSize` 1 to 100 (default 50), `startCursor`. |
| `notion_block_children` | List the child blocks of a block or page by `blockId` (`GET /v1/blocks/{id}/children`), `pageSize` 1 to 100 (default 50), `startCursor`. |
| `notion_comment_list` | List the comments of a block or page by `blockId` (`GET /v1/comments`), `pageSize` 1 to 100 (default 50), `startCursor`. |
| `notion_page_create` (write) | Create a page under `parentPageId` with `title`; optional `titlePropertyName` (default `title`). The title is cut at 2,000 characters. |
| `notion_kb_append` (write) | Create a knowledge-base page in `databaseId` from simple markdown (`bodyMarkdown`) and optional `citationsJson`; optional `titlePropertyName`. Used by Nimbus tribal-knowledge capture. |
| `notion_page_update` (write) | Update a page's properties (`PATCH /v1/pages/{id}`). `propertiesJson` must be a JSON object, passed as a string. |
| `notion_block_append` (write) | Append blocks to `parentBlockId` (`PATCH /v1/blocks/{id}/children`). `childrenJson` must be a JSON array of block objects, passed as a string. |
| `notion_comment_create` (write) | Start a comment thread on a page (`POST /v1/comments`). The text is cut at 2,000 characters. |

### The writes

All five go through the consent registrar and are declared `recoverable: true`. Outside the gateway
each is gated by owner consent, a write-scope allow-list, a mutation budget and an audit record; in
the gateway the executor is the gate. Scope them with `NIMBUS_MCP_NOTION_WRITE_SCOPE`, a
comma-separated list of `kind:value` terms with exact matching. Three kinds exist:

- `page:<pageId>` covers `notion_page_create` (the parent page id), `notion_page_update` and
  `notion_comment_create`.
- `database:<databaseId>` covers `notion_kb_append`.
- `block:<blockId>` covers `notion_block_append` (the parent block id).

An unset or empty scope refuses every write, and an unknown kind fails at startup.

## See also

- [Nimbus Connectors Overview](https://nimbus-agent.dev/user-guide/connectors/)
- [Nimbus Architecture Overview](https://nimbus-agent.dev/architecture-overview/)
- [HITL and Safety](https://nimbus-agent.dev/user-guide/hitl-and-safety/)

## License

AGPL-3.0
