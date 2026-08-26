# Client support

Reads work everywhere. **Writes require your client to implement the MCP `elicitation`
capability**, because that is the only way a server can put a consent prompt in front of you.

A client without it is served **read tools only**. The write tools are not registered at all, rather
than offered ungated. This is the designed behaviour, not a degradation: a tool the model cannot see
is one it cannot call without a human. It also makes the tool list an honest signal — if the writes
are there, consent is enforceable.

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
per-request `_meta` field, and changes how an elicitation reaches the client. The SDK this repository
builds against declares `2025-11-25` and cannot reach the newer model. When a client adopts the new
revision, the observation above needs re-running rather than reinterpreting.
