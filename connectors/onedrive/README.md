# OneDrive Connector

## What this is

First-party Nimbus MCP connector for OneDrive, over Microsoft Graph
(`https://graph.microsoft.com/v1.0`, the signed-in user's `/me/drive`). It exposes four read tools
and two owner-approved write tools to the Nimbus agent (`onedrive_item_list`, `onedrive_item_get`,
`onedrive_item_download`, `onedrive_item_search`, `onedrive_item_delete`, `onedrive_item_move`).
Useful for finding a file, reading it and tidying a folder without leaving the conversation.

Indexes and provides context from OneDrive to the Nimbus agent.

## Install

Bundled with Nimbus — no separate install required.

## Quickstart

```bash
nimbus connector auth onedrive
nimbus ask "Summarize my recent activity in Onedrive"
```

The Gateway manages the Microsoft OAuth flow and injects the access token as an environment variable
at spawn time; the connector itself never touches the vault.

| Variable | Required | Purpose |
| --- | --- | --- |
| `MICROSOFT_OAUTH_ACCESS_TOKEN` | yes | The Microsoft OAuth access token, sent as `Authorization: Bearer <token>`. Read on every call; a missing token fails the call by name. |

The connector does not state which OAuth scopes it needs: neither its code nor its
`nimbus.extension.json` names any. The manifest lists `graph.microsoft.com` and
`login.microsoftonline.com` as its network hosts.

A `nextLink` taken back from a previous list or search response is resolved through
`resolveUrlWithBase`, which refuses an absolute URL on another origin before the token is sent.

Tools exposed:

| Tool | Purpose |
| --- | --- |
| `onedrive_item_list` | List the items under the drive root, or under the folder `parentId` (`/children`). `pageSize` 1-200 (default 50); `nextLink` from the prior response takes precedence and continues that listing. |
| `onedrive_item_get` | Get the metadata of one item (file or folder) by `itemId`. |
| `onedrive_item_download` | Download a file's content as base64 by `itemId`. A folder is refused. `maxBytes` 1024 to 8 MiB (default 256 KiB): a larger file is cut and marked `truncated: true`, with `byteLength` and `returnedBytes`. |
| `onedrive_item_search` | Search under `/me/drive/root/search(q='...')`. `query` 1-500 characters (a single quote is doubled), `pageSize` 1-100 (default 25), optional `nextLink`. |
| `onedrive_item_delete` (write) | Delete an item by `itemId`; answers `{ ok: true }`. |
| `onedrive_item_move` (write) | Move an item to `newParentId` (`PATCH` of `parentReference`), optionally renaming it to `newName` (1-500 characters). |

### The writes

Both go through the consent kit and need owner approval. `onedrive_item_delete` is described as a
permanent delete and is registered as **not** recoverable; the item id is recorded as its audit
pre-state. `onedrive_item_move` is registered as recoverable. Outside the gateway, scope them with
`NIMBUS_MCP_ONEDRIVE_WRITE_SCOPE`, a comma-separated list of `item:<itemId>` terms; both tools are
checked against the `itemId` they act on.

## See also

- [Nimbus Connectors Overview](https://nimbus-agent.dev/user-guide/connectors/)
- [Nimbus Architecture Overview](https://nimbus-agent.dev/architecture-overview/)
- [HITL and Safety](https://nimbus-agent.dev/user-guide/hitl-and-safety/)

## License

AGPL-3.0
