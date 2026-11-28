# Circleci Connector

## What this is

First-party Nimbus MCP connector for [CircleCI](https://circleci.com). It exposes pipelines, their
workflows, a workflow's jobs, a job's artifact metadata and one job's status, plus two owner-approved
write tools: triggering a pipeline and cancelling a job. Useful for incident correlation, such as "did
the deploy pipeline for this branch pass?". `circleci_job_get` is the before-state of the cancel.

## Install

Bundled with Nimbus — no separate install required.

## Quickstart

```bash
nimbus connector auth circleci
nimbus ask "Summarize my recent activity in Circleci"
```

The gateway injects credentials as environment variables at spawn time; the connector itself never
touches the vault. The token is read on every call.

| Variable | Required | Purpose |
| --- | --- | --- |
| `CIRCLECI_API_TOKEN` | yes | A CircleCI API token, sent as the `Circle-Token` header. |
| `NIMBUS_MCP_CIRCLECI_WRITE_SCOPE` | standalone writes only | The write allow-list; see [The writes](#the-writes). Unset means no write is authorised. |

Requests go to `https://circleci.com/api/v2`, which is not configurable. Every request goes through
`guardedFetch`, so it times out after 15 seconds, a redirect on a write is refused (the write may or
may not have been applied), and a read follows a redirect only to the same origin, so the token never
goes to another host. A project slug is split on `/`, each non-empty segment is trimmed and
URL-encoded, and the segments are rejoined into the request path.

Tools exposed:

| Tool | Purpose |
| --- | --- |
| `circleci_pipeline_list` | List a project's pipelines (`projectSlug`, e.g. `gh/org/repo` or `bb/workspace/repo`, at least 3 characters; optional `pageToken`, sent as `page-token`). |
| `circleci_pipeline_get` | Get a pipeline by `pipelineId` (a UUID). |
| `circleci_workflow_list` | List the workflows of a pipeline (`pipelineId`, a UUID). |
| `circleci_job_list` | List the jobs of a workflow (`workflowId`, a UUID). |
| `circleci_job_artifacts` | List the artifact metadata of a job (`projectSlug`, `jobNumber`, an integer of 1 or more). |
| `circleci_job_get` | One job by `projectSlug` and `jobNumber` (`GET /project/{slug}/job/{n}`): `name`, `number`, `status`, `startedAt`, `stoppedAt`, `webUrl`, `pipelineId`, absent fields omitted. A reply with none of them is `CircleCI returned no job`. |
| `circleci_pipeline_trigger` (write) | Trigger a pipeline for `projectSlug` (`POST /project/{slug}/pipeline`) on `tag` if one is given, else on `branch` (default `main`), with optional `parameters` (string keys and string values), sent only when non-empty. |
| `circleci_job_cancel` (write) | Cancel a job by `projectSlug` and `jobNumber` (`POST /project/{slug}/job/{n}/cancel`). |

The reads other than `circleci_job_get` return CircleCI's JSON as it is. `circleci_job_get` is
projected, and its endpoint is not on CircleCI's v2 reference page (which documents `GET /jobs/{job_id}`),
so each field is read under the spelling CircleCI is likely to use; it has not been checked against a
live server.

### The writes

Both are registered through `createWriteToolRegistrar` (`shared/consent-kit.ts`) and declare
`recoverable: true`, so neither captures a pre-state. Standalone, each needs owner consent and a target
allowed by `NIMBUS_MCP_CIRCLECI_WRITE_SCOPE`, a comma-separated list of `kind:value` terms matched
exactly (no prefix match; an empty or unset scope allows nothing, and an unknown kind fails at startup).
The only kind is `project`, whose value is the call's `projectSlug` as given.

| Write | Changes | Scope term |
| --- | --- | --- |
| `circleci_pipeline_trigger` | Starts a new pipeline run on the branch or tag. | `project:<projectSlug>` |
| `circleci_job_cancel` | Cancels the job. | `project:<projectSlug>` |

## See also

- [Nimbus Connectors Overview](https://nimbus-agent.dev/user-guide/connectors/)
- [Nimbus Architecture Overview](https://nimbus-agent.dev/architecture-overview/)
- [HITL and Safety](https://nimbus-agent.dev/user-guide/hitl-and-safety/)

## License

AGPL-3.0
