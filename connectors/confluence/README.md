# Confluence Connector

## What this is

First-party Nimbus MCP connector for Confluence (Atlassian Cloud). Exposes spaces, pages, blog posts
and footer comments to the Nimbus agent (`confluence_space_list`, `confluence_page_list`,
`confluence_page_get`, `confluence_blogpost_list`, `confluence_blogpost_get`,
`confluence_comment_list`), plus five owner-approved write tools (`confluence_page_create`,
`confluence_kb_append`, `confluence_page_update`, `confluence_comment_add`,
`confluence_page_append`). Useful for answering questions from a team's documentation and for
writing results back to it.

Indexes and provides context from Confluence to the Nimbus agent.

## Install

Bundled with Nimbus — no separate install required.

## Quickstart

```bash
nimbus connector auth confluence
nimbus ask "Summarize my recent activity in Confluence"
```

The gateway injects the credentials as environment variables at spawn time; the connector itself
never touches the vault. They are read on every call.

| Variable | Required | Purpose |
| --- | --- | --- |
| `CONFLUENCE_BASE_URL` | yes | The Atlassian site, e.g. `https://example.atlassian.net`. Trailing slashes are stripped, `https://` is added when the value does not start with `http`, and `/wiki` is appended unless it already ends with it. There is no default. |
| `CONFLUENCE_EMAIL` | yes | The Atlassian account email, the username half of the Basic credential. |
| `CONFLUENCE_API_TOKEN` | yes | An Atlassian API token, the password half of the Basic credential. |

Requests go to `<site>/wiki/rest/api/...` with an `Authorization: Basic` header built from the email
and token. Non-2xx answers are reported with Confluence's own body rather than hidden.

Tools exposed:

| Tool | Purpose |
| --- | --- |
| `confluence_space_list` | List spaces (`GET /space`), `limit` 1 to 100 (default 25) and `start` offset (default 0). |
| `confluence_page_list` | List the pages of a space by `spaceKey` (`GET /content`, `type=page`), `limit` 1 to 100 (default 50), `start`; expands last-updated history and version. |
| `confluence_page_get` | Get one page by `pageId` with `body.storage`, version, last-updated history, space and ancestors. `ancestors` is narrowed to `{ id, title }`, top-level page first and direct parent last. |
| `confluence_blogpost_list` | List the blog posts of a space by `spaceKey` (`GET /content`, `type=blogpost`), `limit` 1 to 100 (default 25), `start`. |
| `confluence_blogpost_get` | Get one blog post by `postId` with `body.storage`, version, last-updated history and space. |
| `confluence_comment_list` | List the footer comments of a page by `pageId`, with body and version; `limit` 1 to 100 (default 50), `start`. |
| `confluence_page_create` (write) | Create a page in `spaceKey` with `title` and storage-format `storageHtml`; optional `parentPageId` (`POST /content`). |
| `confluence_kb_append` (write) | Create a knowledge-base page under `parentPageId` in `spaceKey` from simple markdown (`bodyMarkdown`) and optional `citationsJson`. Used by Nimbus tribal-knowledge capture. |
| `confluence_page_update` (write) | Replace a page's title and body (`PUT /content/{id}`). You pass the current `versionNumber`; the call sends it plus one. |
| `confluence_comment_add` (write) | Add a footer comment (`storageHtml`) to a page (`POST /content/{id}/child/comment`). |
| `confluence_page_append` (write) | Append `storageHtml` (at most 65,000 characters) to the end of a page, keeping what is there (`GET` then `PUT`). On a 409 it re-reads and retries once, then fails without writing. |

### The writes

All five go through the consent registrar and are declared `recoverable: true`. Outside the gateway
each is gated by owner consent, a write-scope allow-list, a mutation budget and an audit record; in
the gateway the executor is the gate. Scope them with `NIMBUS_MCP_CONFLUENCE_WRITE_SCOPE`, a
comma-separated list of `kind:value` terms with exact matching. Two kinds exist:

- `space:<spaceKey>` covers `confluence_page_create` and `confluence_kb_append`.
- `page:<pageId>` covers `confluence_page_update`, `confluence_comment_add` and
  `confluence_page_append`.

An unset or empty scope refuses every write, and an unknown kind fails at startup.
`confluence_page_append` notes in its registration that Confluence keeps every version of a page, so
the previous body stays recoverable.

## See also

- [Nimbus Connectors Overview](https://nimbus-agent.dev/user-guide/connectors/)
- [Nimbus Architecture Overview](https://nimbus-agent.dev/architecture-overview/)
- [HITL and Safety](https://nimbus-agent.dev/user-guide/hitl-and-safety/)

## License

AGPL-3.0
