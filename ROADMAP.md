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

- [ ] **MCP revision 2026-07-28.** The SDK this repository builds against declares `2025-11-25`.
  The newer revision moves capability declaration out of the `initialize` handshake and changes
  how an elicitation reaches the client, and standalone consent depends on elicitation
  ([Client support](./docs/client-support.md), "A note on protocol drift"). The row: build
  against an SDK that speaks the newer revision, give the consent kit its successor path, keep
  serving older clients, and re-run the client matrix. What the revision changes is to be read
  from the published specification when this row is designed. The gateway's roadmap carries the
  matching row for its own MCP server
  ([Phase 28](https://github.com/nimbus-agent/Nimbus/blob/main/docs/roadmap.md#phase-28--the-agent-door)).
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

## How this file works

- A row is ticked when it has shipped in a release, with the version.
- A row that needs the gateway says so and links the gateway row it waits on.
- Nothing is added here that the gateway's roadmap sequences; this file follows that order.
