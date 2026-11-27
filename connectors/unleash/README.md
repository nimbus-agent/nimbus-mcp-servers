# Unleash Connector

## What this is

First-party Nimbus MCP connector for [Unleash](https://www.getunleash.io)
feature flags. Exposes the **feature-flag definitions** of every Unleash
project, their live per-environment state, and one owner-approved write tool to
the Nimbus agent (`unleash_list`, `unleash_get`, `unleash_search`,
`unleash_feature_state_get`, `unleash_feature_toggle`). Useful for incident
correlation — "was this flag on in production when the alert fired?".

The gateway indexes flag **definitions** as `unleash:feature_flag` items; the
syncable lives in the Nimbus monorepo, not here. Per-environment strategies are
read live with `unleash_feature_state_get`.

## Install

Bundled with Nimbus — no separate install required.

## Quickstart

```bash
nimbus vault set unleash.api_url https://unleash.example.com
nimbus vault set unleash.api_token <your-unleash-admin-or-personal-access-token>

nimbus ask "Which Unleash flags are stale in the checkout project?"
```

The Gateway injects `unleash.api_url` as `UNLEASH_API_URL` and
`unleash.api_token` as `UNLEASH_API_TOKEN` at spawn time; the connector itself
never touches the vault. Both are read on every call.

| Variable | Required | Purpose |
| --- | --- | --- |
| `UNLEASH_API_URL` | yes | The instance root, e.g. `https://unleash.example.com` or a sub-path install `https://example.com/unleash`. A trailing `/api` is accepted and not doubled. It must be **https**; plain `http` is accepted only for `localhost`, `127.0.0.1` or `[::1]`, so the token never travels in clear text off the machine. Credentials, a query or a fragment in it are refused. There is no default. |
| `UNLEASH_API_TOKEN` | yes | An admin API token or a personal access token, sent as the bare `Authorization: <token>` header, as Unleash's Admin API examples do. The toggle needs a token allowed to update features in that environment. |

Requests go to `${UNLEASH_API_URL}/api/admin/...`, time out after 15 seconds,
and never follow a redirect to another origin.

Tools exposed:

| Tool | Purpose |
| --- | --- |
| `unleash_list` | List projects (no `projectId`), or a project's feature flag definitions (`GET /api/admin/projects/{projectId}/features`), capped at `limit` (default 100) with `total` and `notShown`. |
| `unleash_get` | Fetch one flag by `projectId` + `featureName`, with every environment's enabled state and strategies. |
| `unleash_search` | Search flags by name or tag across projects, or in one (`GET /api/admin/search/features`, present in recent Unleash versions; an older server answers 404, quoted as is). |
| `unleash_feature_state_get` | Read one feature in ONE environment: `enabled`, strategies (capped at 50, each constraint's values capped at 20) and variants (capped at 50). |
| `unleash_feature_toggle` (write) | Turn a feature on or off in ONE environment (`POST .../environments/{environment}/on` or `/off`). |

Project ids, feature names and environment names must be Unleash's URL-friendly
set (letters, digits, `.`, `_`, `~`, `-`, at most 100 characters) and are never
`.` or `..`; anything else is refused before a request.

### The write

`unleash_feature_toggle` declares `hitlRequired: ["write"]` and needs owner
approval. It is its own inverse: toggling back restores the previous on/off
state; strategies and variants are untouched. After the write it reads the
environment back and returns `confirmed: true` only when that read shows the
requested state (a failed read-back is reported as `confirmError`, and the write
is not retried). Unleash refuses the toggle while change requests are enabled for
the environment, and its message is returned as is. Outside the gateway, scope
it with `NIMBUS_MCP_UNLEASH_WRITE_SCOPE=flag:<projectId>/<environment>/<featureName>`.

Unverified against a live server: whether enabling an environment that has no
strategies makes Unleash add its default strategy, as its UI does.
`unleash_feature_state_get` shows the strategies either way.

## See also

- [Nimbus Connectors Overview](https://nimbus-agent.dev/user-guide/connectors/)
- [Nimbus Architecture Overview](https://nimbus-agent.dev/architecture-overview/)
- [HITL and Safety](https://nimbus-agent.dev/user-guide/hitl-and-safety/)

## License

AGPL-3.0
