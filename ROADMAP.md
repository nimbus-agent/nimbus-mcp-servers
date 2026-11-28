# nimbus-mcp-servers — Roadmap

`@nimbus-dev/connectors`: the first-party Nimbus connectors in one package, each also runnable on
its own over stdio for any MCP client.

This file owns one question: **what is planned for the connectors themselves.** It does not own
the build order (that is the spine in the gateway's
[roadmap](https://github.com/nimbus-agent/Nimbus/blob/main/docs/roadmap.md)), the gateway's sync
and indexing of what these connectors return (also there), or how the repositories fit together
([ECOSYSTEM.md](https://github.com/nimbus-agent/.github/blob/main/ECOSYSTEM.md)). What has shipped
is in [`CHANGELOG.md`](./CHANGELOG.md).

## Where this is going

The gateway's roadmap records the direction (2026-11-12): Nimbus as the trust layer between AI
agents and engineering systems
([§ Direction](https://github.com/nimbus-agent/Nimbus/blob/main/docs/roadmap.md#direction)). The
connectors are the hands of that layer. Run through the gateway they sit behind its consent gate,
its sandbox and its egress ledger; run standalone they keep only what this repository can give
them, which [`NOTICE`](./NOTICE) states exactly. Nothing below changes that split.

## Open rows

- [ ] **MCP revision 2026-07-28.** *Built in 0.15.0; run against an independent 2026-07-28 client, the Python MCP SDK 2.3.0, on 2026-11-24 (listing, the hidden-writes rule and the consent round trip in both eras, [Client support](./docs/client-support.md)); not yet against a shipped application.* A
  standalone connector runs on the MCP server layer of `@nimbus-dev/sdk` and answers both a
  2026-07-28 client and one that opens with `initialize`; the consent kit asks through an input
  request with a sealed, single-use state ([Client support](./docs/client-support.md), "A note
  on protocol drift"; [SECURITY](./SECURITY.md)). One file, `shared/connector-server.ts`, builds
  every connector's server. What keeps the row open: re-running the client matrix with a shipped
  2026-07-28 application (an SDK client has been run; no shipped application has). A gateway-started connector stays on the
  upstream SDK by design. The gateway's roadmap carries the matching row for its own MCP server
  ([Phase 28](https://github.com/nimbus-agent/Nimbus/blob/main/docs/roadmap.md#phase-28--the-agent-door)).
- [x] **Audit connector error text.** *Shipped in 0.23.0.* A tool's thrown message reached the
  standalone client verbatim. The audit found reply bodies (token endpoints among them), CLI
  stderr and stdout, and fs errors carrying credentials and local paths into it; every message
  now passes through `shared/error-text.ts` first, and a CLI's stdout is no longer quoted. What it
  leaves open is in [SECURITY](./SECURITY.md): a derived credential with no known shape, and the
  gateway path, which keeps the upstream server.
- [ ] **Cost connectors.** `vantage` shipped in 0.14.0, read-only. The other platforms named in
  the gateway's *FinOps connectors* row
  ([Phase 10](https://github.com/nimbus-agent/Nimbus/blob/main/docs/roadmap.md#phase-10--the-autonomous-agent))
  land here one connector at a time, and so would the raw cloud-billing intake its
  [Phase 30](https://github.com/nimbus-agent/Nimbus/blob/main/docs/roadmap.md#phase-30--the-cost-pack)
  plans. Sync and indexing stay in the gateway.
- [ ] **Per-connector READMEs.** Some, `github`, `slack` and `jira` among them, are still only a
  short gateway quickstart. Each should document its tools, its credentials and its write scopes.
- [ ] **Re-measure the client-support matrix.** It is a dated observation (2026-08-24): one client
  measured, two rows taken from vendor documentation. Measure the two unmeasured clients, and
  measure again when a client adopts the newer protocol revision.
- [ ] **Connector follow-ups the gateway's write work named.** The gateway's
  [Phase 9.7](https://github.com/nimbus-agent/Nimbus/blob/main/docs/roadmap.md#phase-97--connector-write-enablement-the-acting-roster)
  lists tools it needed and did not find here. Each is a small connector change with its own
  release.
  - [x] **Code review and issue writes:** GitHub PR review / line comment, Bitbucket PR comment,
    GitHub/GitLab label and assignee remove, GitHub/GitLab issue title and body edit, Jira
    assignee, Linear labels. *Shipped: the Bitbucket PR comment in 0.18.0, the rest in 0.19.0.*
  - [x] **Google Calendar writes:** create, update, delete. This is the first write on the
    connector, and the gateway must pass the granted scopes at spawn. *Shipped in 0.20.0.*
  - [x] **Infra reads and fixes:** `aws_lambda_get`; Snowflake `TAG_REFERENCES` selecting
    `tag_database` and `tag_schema`; `iac_terraform_init`; a read of a stack's change sets.
    *Shipped in 0.21.0.*
  - [x] **Flag connectors:** Unleash and Split, as new connectors with writes. *Shipped in
    0.22.0.*
  - [x] **Investigate:** a head-commit precondition for `bitbucket_pr_merge`. *Closed
    2026-11-27: impossible upstream.* Bitbucket Cloud's merge body
    (`pullrequest_merge_parameters`) has only `type`, `message`, `close_source_branch` and
    `merge_strategy`, the endpoint's one parameter is `async`, and no `If-Match` or ETag
    precondition is documented (Atlassian's published OpenAPI spec, `swagger.v3.json`). A
    re-read before the merge would only narrow the race, so `bitbucket_pr_merge` stays never
    offered to the model.

  Dropped: Opsgenie (replaced by Jira Service Management, OR-W34-7), and REST readers for
  `az`/`gcloud` (not taken, OR-97-1).

## How this file works

- A row is ticked when it has shipped in a release, with the version.
- A row that needs the gateway says so and links the gateway row it waits on.
- Nothing is added here that the gateway's roadmap sequences; this file follows that order.
