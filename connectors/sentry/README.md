# Sentry Connector

## What this is

First-party Nimbus MCP connector for [Sentry](https://sentry.io). It is read-only and exposes two
tools to the Nimbus agent: `sentry_issue_list` and `sentry_release_list`. Useful for incident
correlation — "which errors are unresolved in this project, and what shipped recently?".

The gateway indexes and provides context from Sentry; that syncable lives in the Nimbus monorepo,
not here.

## Install

Bundled with Nimbus — no separate install required.

## Quickstart

```bash
nimbus connector auth sentry
nimbus ask "Summarize my recent activity in Sentry"
```

The gateway injects the credentials as environment variables at spawn time; the connector itself
never touches the vault. All are read on every call.

| Variable | Required | Purpose |
| --- | --- | --- |
| `SENTRY_AUTH_TOKEN` | yes | Sent as `Authorization: Bearer <token>`. |
| `SENTRY_ORG_SLUG` | yes | The organization slug used in every project path. |
| `SENTRY_URL` | no | The Sentry instance root, for self-hosted installs; one trailing `/` is dropped. Defaults to `https://sentry.io`. |

Requests go to `<SENTRY_URL>/api/0/...`, time out after 15 seconds, and follow a redirect only to
the same origin or the same host's http to https upgrade, at most 3 hops.

Tools exposed:

| Tool | Purpose |
| --- | --- |
| `sentry_issue_list` | List unresolved issues (`query=is:unresolved`) for `projectSlug`, capped at `limit` (integer 1 to 100, default 20). |
| `sentry_release_list` | List releases for `projectSlug` (`GET /projects/<org>/<projectSlug>/releases/`). |

Both tools are reads; this connector has no write tools and so no write scope.

## See also

- [Nimbus Connectors Overview](https://nimbus-agent.dev/user-guide/connectors/)
- [Nimbus Architecture Overview](https://nimbus-agent.dev/architecture-overview/)
- [HITL and Safety](https://nimbus-agent.dev/user-guide/hitl-and-safety/)

## License

AGPL-3.0
