# Client support

Reads work everywhere. **Writes require your client to implement the MCP `elicitation`
capability**, because that is the only way a server can put a consent prompt in front of you.

A client without it is **listed read tools only**. The write tools are left out of `tools/list`,
rather than offered ungated, and a call that names one anyway is refused before anything runs and
recorded in the audit log (`client cannot prompt`). This is the designed behaviour, not a
degradation: a tool the model is not shown is one it has no reason to call, and one it cannot run
without a human. It also makes the tool list an honest signal — if the writes are there, consent
is enforceable.

## The matrix

**This table is a dated observation, not a standing guarantee.** Client support changes between
releases, so the version tested is part of the claim. Re-check yours rather than trusting a row.

| Client | Version tested | `elicitation` | Basis | You get |
| --- | --- | --- | --- | --- |
| **Claude Desktop** | 1.34493.1 (MSIX) | **no** | **observed** | **reads only** |
| Claude Code | not tested | yes — form + URL | vendor docs | reads and writes |
| Cursor | not tested | yes, since v1.5 | vendor changelog | reads and writes |
| Anything else | — | check it | — | reads, plus writes if it advertises `elicitation` |

Measured 2026-08-24 against the `github` connector, which exposes 9 read tools and 5 write tools
(`github_pr_merge`, `github_branch_delete`, `github_issue_create`, `github_pr_close`,
`github_tag_create`).

## The two numbers have different provenance

This distinction matters more than the numbers do.

- **9 — observed from the real client.** Claude Desktop 1.34493.1, negotiating protocol
  `2025-11-25`, declared only `roots` and `io.modelcontextprotocol/ui` in its `initialize` frame —
  no `elicitation` — and its own log recorded `Connected to nimbus-github (9 tools)`. Asking it to
  list them returned exactly the nine reads.
- **14 — from a synthetic client.** An SDK client declaring `{ elicitation: {} }`, not a shipped
  application. It establishes what a supporting client *would* be served. It is not evidence about
  any product.

The Claude Code and Cursor rows are vendor documentation only — **not measured here**, and not
implied to be by the 14.

## Checking your own client

One query: ask it to list the connector's tools. If the write tools are absent, your client does not
implement elicitation. Nothing else needs checking, and no configuration changes the answer.

## A note on protocol drift

MCP revision 2026-07-28 moves capability declaration out of the `initialize` handshake and into a
per-request `_meta` field, and changes how an elicitation reaches the client: a server may no
longer send the client a request, so a write tool answers `input_required` and the client calls
it again with the person's answer.

A standalone connector serves both. Since 0.15.0 it runs on the MCP server layer of
`@nimbus-dev/sdk`, which answers a 2026-07-28 client and a client that opens with `initialize`
(`2025-11-25`, `2025-06-18`, `2025-03-26`, `2024-11-05`) from one process, and decides which a
connection is by its first request. The consent rules are the same in each. What differs:

- **2026-07-28:** capabilities come with every request, so the write tools are listed, or not,
  per request. The approval travels back in a second call, with a state the connector sealed
  (see [SECURITY](../SECURITY.md)).
- **`initialize` clients:** the connector sends the older `elicitation/create` request, as
  before. Two notifications these clients used to get are no longer sent: the tool-list-changed
  notice when the write budget runs out (a call is still refused), and the per-write log
  messages (each record is written to the connector's stderr, and to the audit log when one is
  configured).

**Not verified:** no shipped 2026-07-28 client has been run against a connector. That era is
tested with requests scripted from the published specification; the `initialize` era is tested
with the upstream MCP SDK's own client. The matrix above predates this change and its rows are
all `initialize` clients; a row for a 2026-07-28 client waits for one to test with.

A connector the Nimbus gateway starts is unchanged: it still runs on the upstream MCP SDK and the
`initialize` handshake, since the gateway is its only client and approves its writes itself.
