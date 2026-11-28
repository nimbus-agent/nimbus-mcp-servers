# Google Drive Connector

## What this is

First-party Nimbus MCP connector for Google Drive, over the Drive API v3
(`https://www.googleapis.com/drive/v3`). It exposes four read tools and four owner-approved write
tools to the Nimbus agent (`gdrive_file_list`, `gdrive_file_metadata`, `gdrive_file_search`,
`gdrive_file_download`, `gdrive_file_create`, `gdrive_file_trash`, `gdrive_file_move`,
`gdrive_file_rename`). Useful for finding a document, reading its text and filing it away without
leaving the conversation.

Indexes and provides context from Google Drive to the Nimbus agent.

## Install

Bundled with Nimbus — no separate install required.

## Quickstart

```bash
nimbus connector auth google-drive
nimbus ask "Summarize my recent activity in Google Drive"
```

The Gateway manages the Google OAuth flow and injects the access token as an environment variable at
spawn time; the connector itself never touches the vault.

| Variable | Required | Purpose |
| --- | --- | --- |
| `GOOGLE_OAUTH_ACCESS_TOKEN` | yes | The Google OAuth access token, sent as `Authorization: Bearer <token>`. Read on every call; a missing token fails the call by name. |

The connector does not state which OAuth scopes it needs: neither its code nor its
`nimbus.extension.json` names any. The manifest lists `www.googleapis.com`,
`oauth2.googleapis.com` and `accounts.google.com` as its network hosts.

Every request goes to a fixed `https://www.googleapis.com` URL (uploads to
`https://www.googleapis.com/upload/drive/v3/files`); a `pageToken` is passed back to Drive as a query
parameter, never fetched as a URL.

Tools exposed:

| Tool | Purpose |
| --- | --- |
| `gdrive_file_list` | List non-trashed files (`trashed = false`), metadata only. `pageSize` 1-100 (default 25), optional `pageToken` from the previous response. |
| `gdrive_file_metadata` | Metadata of one file or folder by `fileId`: owners, parents, links, mimeType, description, size, times, `shared`. |
| `gdrive_file_search` | Full-text search (`fullText contains '<query>'`, the query escaped), non-trashed files only. `query` 1-500 characters, `pageSize` 1-100 (default 25), optional `pageToken`. |
| `gdrive_file_download` | Download a file by `fileId`. Google Docs are exported as plain text and Sheets as CSV; other Google Workspace types answer `EXPORT_NOT_SUPPORTED`. `text/*` files come back as utf-8, anything else as base64. `maxBytes` 1024 to 16 MiB (default 256 KiB). |
| `gdrive_file_create` (write) | Create a file: `name` (1-500 characters), optional `mimeType` (default `text/plain`), `parentId` and text `content` (up to 4,000,000 characters, sent as a multipart upload). Without `content` an empty file is created. |
| `gdrive_file_trash` (write) | Move a file or folder to the Drive trash (`PATCH` with `trashed: true`). |
| `gdrive_file_move` (write) | Move a file or folder to `newParentId`. `removeParentId` defaults to the file's first current parent; a file with no parent is refused. |
| `gdrive_file_rename` (write) | Rename a file or folder to `newName` (1-500 characters). |

A Google Docs or Sheets export is cut at `maxBytes` and marked `truncated: true`. For any other file,
one larger than `maxBytes` is refused with a `FILE_TOO_LARGE` error that carries `sizeBytes` and
`maxBytes`, rather than returned cut.

### The writes

All four go through the consent kit and need owner approval, and all four are registered as
recoverable (for `gdrive_file_trash` the code notes that Drive keeps a trashed item for 30 days and
it can be restored from the trash). Outside the
gateway, scope them with `NIMBUS_MCP_GOOGLE_DRIVE_WRITE_SCOPE`, a comma-separated list of
`folder:<id>` and `file:<id>` terms. `gdrive_file_create` is checked against the folder
(`folder:<parentId>`, or `folder:root` when `parentId` is left out); trash, move and rename against
`file:<fileId>`.

## See also

- [Nimbus Connectors Overview](https://nimbus-agent.dev/user-guide/connectors/)
- [Nimbus Architecture Overview](https://nimbus-agent.dev/architecture-overview/)
- [HITL and Safety](https://nimbus-agent.dev/user-guide/hitl-and-safety/)

## License

AGPL-3.0
