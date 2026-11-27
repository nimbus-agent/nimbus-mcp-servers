# Split Connector

## What this is

First-party Nimbus MCP connector for [Split](https://www.split.io) (now Harness
Feature Management & Experimentation) feature flags, which Split calls
**splits**. Exposes the split definitions of each workspace, their live
per-environment definition, and two owner-approved write tools to the Nimbus
agent (`split_list`, `split_get`, `split_search`, `split_definition_get`,
`split_kill`, `split_restore`). Useful for incident correlation — "was this
flag killed when the alert fired?".

The gateway indexes split **definitions** as `split:feature_flag` items; the
syncable lives in the Nimbus monorepo, not here. Treatments, targeting rules and
the killed state are read live with `split_definition_get`.

## Install

Bundled with Nimbus — no separate install required.

## Quickstart

```bash
nimbus vault set split.admin_api_key <your-split-admin-api-key>

nimbus ask "Which Split flags in the web workspace are killed in production?"
```

The Gateway injects `split.admin_api_key` as `SPLIT_ADMIN_API_KEY` at spawn
time; the connector itself never touches the vault.

| Variable | Required | Purpose |
| --- | --- | --- |
| `SPLIT_ADMIN_API_KEY` | yes | A Split **Admin** API key, sent as `Authorization: Bearer <key>`. The reads need a role that can view feature flags; the kill and restore need `API_ALL_GRANTED` or `API_FEATURE_FLAG_EDITOR`. |

Every request goes to `https://api.split.io/internal/api/v2`. The host is fixed:
there is no base-URL override, so the key goes to Split and nowhere else, and a
redirect to another origin is never followed.

Tools exposed:

| Tool | Purpose |
| --- | --- |
| `split_list` | List workspaces (no `workspaceId`), one page of a workspace's splits (`offset`, `limit` up to 50; the reply's `totalCount` says how many exist), or with `collection: "environments"` its environments. |
| `split_get` | Fetch one split's definition by `workspaceId` + `splitName`; every list in it (tags, flag sets) is capped at 50, the rest counted. |
| `split_search` | Substring search across a workspace's splits (name, description, tags). Split has no search endpoint, so this walks the list, at most 1,000 splits, and says `truncated: true` beyond that. |
| `split_definition_get` | Read one split in ONE environment (by id or case-sensitive name): `killed`, default and baseline treatment, traffic allocation, treatments (capped at 50, each configuration cut at 2,000 characters, each treatment's targeted `keys` and `segments` capped at 20), targeting rules (capped at 20, each matcher's lists capped at 20) and the default rule. |
| `split_kill` (write) | Kill a split in ONE environment (`PUT .../environments/{environment}/kill`): every evaluation serves its default treatment. |
| `split_restore` (write) | Restore a killed split in ONE environment (`PUT .../environments/{environment}/restore`): its rules apply again. |

Workspace ids, split names and environment ids or names must be letters, digits,
`.`, `_`, `~` or `-`, at most 128 characters, and never `.` or `..`. An
environment name may also hold single inner spaces (`Production EU`; no leading,
trailing or repeated space), which is percent-encoded in the path. Anything else
is refused before a request.

### The writes

`split_kill` and `split_restore` declare `hitlRequired: ["write"]` and each
needs owner approval. Each is the other's inverse. Both send a `comment` that
says the change was made by Nimbus after owner approval, then read the
definition back and return `confirmed: true` only when that read shows the
requested `killed` state (a failed read-back is reported as `confirmError`, and
the write is not retried). Outside the gateway, scope them with
`NIMBUS_MCP_SPLIT_WRITE_SCOPE=flag:<workspaceId>/<environment>/<splitName>`,
where `<environment>` is written exactly as the tool is called with it (id or
name).

## See also

- [Nimbus Connectors Overview](https://nimbus-agent.dev/user-guide/connectors/)
- [Nimbus Architecture Overview](https://nimbus-agent.dev/architecture-overview/)
- [HITL and Safety](https://nimbus-agent.dev/user-guide/hitl-and-safety/)

## License

AGPL-3.0
