# Google Photos Connector

## What this is

First-party Nimbus MCP connector for Google Photos, over the Photos Library API
(`https://photoslibrary.googleapis.com/v1`). It is read-only: five tools list and fetch albums and
media-item metadata (`gphotos_album_list`, `gphotos_album_get`, `gphotos_media_list`,
`gphotos_media_get`, `gphotos_media_search`). Useful for answering "which album is that trip in?"
from metadata alone.

Indexes and provides context from Google Photos to the Nimbus agent.

## Install

Bundled with Nimbus — no separate install required.

## Quickstart

```bash
nimbus connector auth google-photos
nimbus ask "Summarize my recent activity in Google Photos"
```

The Gateway manages the Google OAuth flow and injects the access token as an environment variable at
spawn time; the connector itself never touches the vault.

| Variable | Required | Purpose |
| --- | --- | --- |
| `GOOGLE_OAUTH_ACCESS_TOKEN` | yes | The Google OAuth access token, sent as a Bearer `Authorization` header to `photoslibrary.googleapis.com`. |

The connector does not state which OAuth scopes it needs: neither its code nor its
`nimbus.extension.json` names any. The manifest lists `www.googleapis.com`,
`photoslibrary.googleapis.com` and `oauth2.googleapis.com` as its network hosts and declares no
`hitlRequired` operations.

Tools exposed:

| Tool | Purpose |
| --- | --- |
| `gphotos_album_list` | List albums (`GET /albums`), metadata. `pageSize` 1-50 (default 25), optional `pageToken`. |
| `gphotos_album_get` | Get one album by `albumId` (title, item count, cover photo base URL). |
| `gphotos_media_list` | List media items (`POST /mediaItems:search`): metadata plus `baseUrl` and `productUrl` only. Optional `albumId`, `pageSize` 1-100 (default 50), optional `pageToken`. |
| `gphotos_media_get` | Get the metadata of one media item by `mediaItemId`. |
| `gphotos_media_search` | Search media items (`POST /mediaItems:search`), metadata only. Optional `albumId`, `pageSize` 1-100 (default 50), `pageToken`, and the filters `includeArchivedMedia` and `excludeNonAppCreatedData` (each sent only when `true`). |

Path values are URL-encoded. The connector registers no write tool, so there is no write scope.

## See also

- [Nimbus Connectors Overview](https://nimbus-agent.dev/user-guide/connectors/)
- [Nimbus Architecture Overview](https://nimbus-agent.dev/architecture-overview/)
- [HITL and Safety](https://nimbus-agent.dev/user-guide/hitl-and-safety/)

## License

AGPL-3.0
