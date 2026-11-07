# Circleci Connector

## What this is

Nimbus MCP connector for Circleci. Indexes and provides context from Circleci to the Nimbus agent.

## Install

Bundled with Nimbus — no separate install required.

## Quickstart

```bash
nimbus connector auth circleci
nimbus ask "Summarize my recent activity in Circleci"
```

## Behaviour notes

- Every request goes through `guardedFetch`: a redirect on a write is refused, and a read follows a
  redirect only to the same origin.
- `circleci_job_get {projectSlug, jobNumber}` returns `{name, number, status, startedAt, stoppedAt,
  webUrl, pipelineId}` (absent fields omitted), the before-state of `circleci_job_cancel`. It calls
  `GET /project/{slug}/job/{n}`, which the CircleCI v2 reference page does not document (it documents
  `GET /jobs/{job_id}`): live check the endpoint and its fields.

## See also

- [Circleci Connector Documentation](https://nimbus-agent.dev/user-guide/connectors/)
- [Nimbus Architecture Overview](https://nimbus-agent.dev/architecture-overview/)
- [HITL and Safety](https://nimbus-agent.dev/user-guide/hitl-and-safety/)

## License

AGPL-3.0
