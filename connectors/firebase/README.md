# Firebase App Distribution Connector

## What this is

First-party Nimbus MCP connector for
[Firebase App Distribution](https://firebase.google.com/docs/app-distribution),
via the [App Distribution REST API](https://firebase.google.com/docs/reference/app-distribution/rest).
Indexes each configured app's recent **releases** into the local index as
`firebase:release` items and exposes read tools (`firebase_list`, `firebase_get`,
`firebase_search`) and one owner-approved write tool
(`firebase_app_distribution_distribute`).

## Install

Bundled with Nimbus — no separate install required.

## Quickstart

```bash
nimbus vault set firebase.service_account_json "$(cat service-account.json)"
nimbus vault set firebase.app_ids "1:1234567890:android:abcdef,1:1234567890:ios:012345"
nimbus ask "What are the latest Firebase App Distribution releases for the Android app?"
```

The credentials come from the Google Cloud / Firebase console:

- **`firebase.service_account_json`** — a Google **service account** key JSON
  (the file downloaded from IAM → Service Accounts → Keys) for a service account
  granted the Firebase App Distribution Viewer (or Admin) role.
- **`firebase.app_ids`** — a comma-separated list of Firebase **app ids** (the
  `1:<projectNumber>:<platform>:<hash>` strings from the Firebase console). The
  project number is the second colon-segment and is derived automatically.

The Gateway injects them as `FIREBASE_SERVICE_ACCOUNT_JSON` / `FIREBASE_APP_IDS`
env at spawn time; the connector itself never touches the vault, and both must
be set or the connector no-ops.

## Authentication

App Distribution's REST API is a Google Cloud API: it accepts a short-lived
OAuth2 **Bearer** access token. The connector mints that token from the service
account key using the **JWT-bearer grant** — it signs an RS256 JWT assertion
(scope `cloud-platform`, `aud` = the SA's `token_uri`) with `node:crypto` and
exchanges it at `https://oauth2.googleapis.com/token` for an access token. No
`googleapis` dependency. The minted token is cached in-process and refreshed
conservatively (~30 min). The gateway-side syncable
(`packages/gateway/src/connectors/firebase-sync.ts`) walks
`GET /v1/projects/<projectNumber>/apps/<appId>/releases` for each configured app
and upserts each release with metadata
`{ app_id, display_version, build_version, create_time, release_notes_text,
firebase_console_uri, testing_uri, binary_download_uri }`. The
`binary_download_uri` is stored as a string but its contents are **never
fetched** — it is a binary download link, not data to index.

Tools exposed:

| Tool              | Purpose                                                                            |
| ----------------- | --------------------------------------------------------------------------------- |
| `firebase_list`   | List the configured app ids, or recent releases for an app (pageSize optional).   |
| `firebase_get`    | Fetch a single release by `appId` + `releaseId`.                                   |
| `firebase_search` | Substring search across an app's recent releases (display/build version, notes).   |
| `firebase_app_distribution_distribute` | WRITE. `POST /v1/projects/<n>/apps/<appId>/releases/<releaseId>:distribute`, body `{ testerEmails, groupAliases }` with empty arrays omitted, at least one of the two, at most 999 together. **An email that is not yet a tester becomes a new tester and is sent an invitation email, and testers get a release email; none of it can be unsent.** The app must be in `FIREBASE_APP_IDS`. Mutates `firebase.release.distribute`; not recoverable, the release (version, build, test state) is audited first. Scope `app:<appId>`. |

### Write tools

Each write needs the owner's approval (`hitlRequired: ["write"]`). Standalone, set `NIMBUS_MCP_FIREBASE_WRITE_SCOPE` to `app:<appId>` terms; see `docs/configuration.md`. The result says `accepted` and lists every group and tester sent; nothing here reports the release as delivered. Every App Distribution request now goes through the shared redirect guard, so the bearer token is never re-sent to a redirect target and a redirect on a write is refused.

The API cannot say who already has a release (a release has no groups or testers field), so the only before-state is the release itself and the owner's preview lists everything it will add. Not verified against a live account: that a missing group answers INVALID_ARGUMENT, and the exact status of an email Firebase rejects. Creating releases and managing tester groups are not built.

## See also

- [Nimbus Connectors Overview](https://nimbus-agent.dev/user-guide/connectors/)
- [Nimbus Architecture Overview](https://nimbus-agent.dev/architecture-overview/)
- [HITL and Safety](https://nimbus-agent.dev/user-guide/hitl-and-safety/)

## License

AGPL-3.0
