# Nimbus MCP Servers

Standalone, MCP-standard [**Nimbus**](https://github.com/nimbus-agent/Nimbus) connectors — usable by **any** MCP client (Claude Desktop, Cursor, …), not just the Nimbus gateway.

> **Status: SCAFFOLD — not yet built.** This repo holds its vision and a [build prompt](./NEW-SESSION-PROMPT.md). There is a load-bearing design decision to make first (see below).

## The opportunity

Nimbus ships ~94 first-party MCP connectors in [`packages/mcp-connectors`](https://github.com/nimbus-agent/Nimbus/tree/main/packages/mcp-connectors). They speak standard MCP — but today they are bundled with the gateway and coupled to gateway-internal seams:

- the lazy-mesh **sandbox** wrapper (`wrapServerSpec`, invariant I15), and
- **credential injection** from the OS Vault at spawn time.

If a curated subset is published as **standalone** MCP servers — runnable independently over stdio with credentials supplied via environment variables — the whole MCP ecosystem can use them (`npx @nimbus/mcp-github`, a Claude Desktop config entry, a Cursor MCP server), which expands reach and funnels users back to Nimbus.

## The decision to make first

How to decouple from the gateway-internal seams without forking 94 connectors into drift:

- **Share vs vendor vs fork** the connector code relative to the monorepo.
- The **credential model** outside the Vault (env-only, with clear docs).
- **AGPL-3.0 implications** for downstream MCP clients that embed these servers (this repo is AGPL — see [LICENSE](./LICENSE)).

This is genuinely architectural; the build prompt routes it through a brainstorm first.

## Candidate first connectors

Connectors that are naturally standalone (token/env auth, no gateway-specific indexing assumptions) make the best first targets — e.g. **github**, **linear** — with a repeatable template for the rest.

## License

[AGPL-3.0](./LICENSE) — consistent with the connector code in the main repo.
