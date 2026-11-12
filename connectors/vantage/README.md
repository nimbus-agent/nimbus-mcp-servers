# Vantage Connector

## What this is

First-party Nimbus MCP connector for [Vantage](https://www.vantage.sh/), the cloud and SaaS cost
platform. It exposes four **read-only** tools that read cost data and active cost-saving
recommendations from the Vantage API v2 (`https://api.vantage.sh/v2`): `vantage_cost_list`,
`vantage_recommendation_list`, `vantage_cost_get` and `vantage_search`.

It never writes. Every request is a `GET`, the manifest declares no HITL action
(`hitlRequired` is `[]`), and the only network host is `api.vantage.sh`.

## Install

Bundled with Nimbus. No separate install is required.

## Quickstart

```bash
nimbus vault set vantage.api_token <your-read-only-vantage-token>

# Optional
nimbus vault set vantage.cost_report_token <report-token>
nimbus vault set vantage.workspace_token  <workspace-token>
nimbus vault set vantage.group_by         provider,service,region
```

The gateway injects the Vault keys as environment variables at spawn time; the connector itself
never touches the Vault. (The Vault keys are registered on the gateway side by the Nimbus release
that adds the Vantage syncable; this README lists the variables the connector reads.)

Create a **Read-only** API token in Vantage (Settings, API Access Tokens). Nimbus cannot check a
token's scope, so the read-only property rests on the token you create, not on the connector. The
connector sends `Authorization: Bearer <token>` and nothing but `GET`.

## Environment

| Variable | Required | Purpose |
| --- | --- | --- |
| `VANTAGE_API_TOKEN` | yes | The API token, sent as `Authorization: Bearer <token>`. |
| `VANTAGE_COST_REPORT_TOKEN` | no | Query costs through this saved cost report. When set and `VANTAGE_GROUP_BY` is not, the report's own groupings apply. |
| `VANTAGE_WORKSPACE_TOKEN` | no | Workspace to query. Vantage requires it when the API token spans several workspaces; it is ignored by `/costs` when a report token is set. |
| `VANTAGE_GROUP_BY` | no | Comma-separated groupings, for example `provider,service,region` or `tag:team`. Overrides the report's groupings. |

Without a report token and without `VANTAGE_GROUP_BY`, costs are grouped by
`provider,service,account_id`.

## Tools

| Tool | Purpose |
| --- | --- |
| `vantage_cost_list` | `GET /costs`, day-binned. Inputs: `sinceMs`, `untilMs` (epoch ms; UTC dates are sent, `untilMs` defaults to now), `limit` (1 to 5000, default 5000), `cursor`. Returns `{ items, nextCursor }`. |
| `vantage_recommendation_list` | `GET /recommendations?status=active`. Inputs: `limit` (1 to 1000, default 1000), `cursor`. Returns `{ items, nextCursor }`. |
| `vantage_cost_get` | `GET /cost_reports/{id}`: one cost report definition (title, workspace, saved groupings, filter, dates). Returns the raw body. |
| `vantage_search` | Substring search (description, type, service, provider, category) over the first 1000 active recommendations. Returns `{ matches }`. |

`nextCursor` is the next page number, as a string, while Vantage's `links.next` is a non-empty
string, and `null` on the last page. The connector never fetches the `links.next` URL; the cursor is
only ever turned into a `page` query parameter, and a cursor that is not a page number is refused
before any request.

Cost rows are returned exactly as Vantage sends them. Where a custom `tag:<key>` grouping appears
in a row is not documented in the OpenAPI file, so the connector does not interpret it.

## Rate limits

Vantage allows 1,000 requests per hour, and the Cost Report endpoints 5 requests per 5 seconds
(<https://docs.vantage.sh/api/rate_limiting>). Whether `GET /costs` counts toward the second limit
is **unverified**, so the connector spaces `GET /costs` requests at least 1.2 seconds apart
regardless. The first `429` on any endpoint ends the call with an error that names the reset time
from the `x-rate-limit-reset` header (unix seconds) or says it is unknown. The connector does not
retry.

## UNVERIFIED facts

The test fixtures are shaped from Vantage's published OpenAPI file
(<https://api.vantage.sh/v2/oas_v3.json>) and its documented examples. They are not recordings of a
live account, and no request has been made to one. These facts are therefore unconfirmed:

- `Authorization: Bearer <token>` is from Vantage's authentication docs page. The OpenAPI file
  declares only an `oauth2` scheme.
- `start_date` and `end_date` are documented as "ISO 8601 formatted" strings with no declared
  format. The connector sends `YYYY-MM-DD` (UTC). `end_date` is always sent; `start_date` only when
  `sinceMs` is given.
- Whether `GET /costs` without a report token or filter returns data for the whole workspace by
  default is not stated by the file. The connector sends `provider,service,account_id` groupings in
  that case.
- The `x-rate-limit-reset` header and the 1.2 s pacing assumption come from the rate-limiting docs
  page; a `429` is not listed in the operation's responses.
- The `vantage_search` tool sees only the first 1000 active recommendations (one request).

## See also

- [Nimbus Connectors Overview](https://nimbus-agent.dev/user-guide/connectors/)
- [Nimbus Architecture Overview](https://nimbus-agent.dev/architecture-overview/)

## License

AGPL-3.0
