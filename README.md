# Nimbus MCP Servers

Standalone, MCP-standard [**Nimbus**](https://github.com/nimbus-agent/Nimbus) connectors — usable by
**any** MCP client (Claude Code, Cursor, Claude Desktop, …), not just the Nimbus gateway.

All **94** connectors ship in one package, `@nimbus-dev/connectors`, each runnable standalone over
stdio with credentials supplied from the environment.

```bash
npx @nimbus-dev/connectors github
```

## What you get, and what you do not

Run standalone, a connector gives you:

- **Consent before every mutation.** A write tool asks your MCP client to put the exact operation and
  parameters in front of you, and does nothing unless you approve.
- **A write-scope allow-list**, enforced by the server and unreachable by the model.
- **A mutation budget** per session, which caps a runaway agent loop.
- **A local, hash-chained, append-only audit log**, when `NIMBUS_MCP_AUDIT_LOG` is set.

It does **not** give you the process sandbox, OS-keychain credential storage, the egress ledger, or
owner-controlled consent. Those are properties of the Nimbus gateway and no published package can
supply them. [`NOTICE`](./NOTICE) states the tiering that notice asks you to preserve.

## Writes depend on your client

Reads work everywhere. **Writes require your client to implement the MCP `elicitation` capability**,
because that is the only way a server can put a consent prompt in front of you. Without it, write
tools are **not registered at all** rather than offered ungated — deliberate, not a defect: a tool
the model cannot see is one it cannot call without a human.

**Claude Desktop does not implement elicitation today**, so you get reads only there. Claude Code and
Cursor do, per their vendor docs.

Checking your own client takes one query: ask it to list the connector's tools. If the write tools are
absent, your client does not implement elicitation.

Full matrix, versions tested, and the provenance of each claim:
[Client support](./docs/client-support.md).

## Configuration

```json
{
  "mcpServers": {
    "nimbus-github": {
      "command": "npx",
      "args": ["-y", "@nimbus-dev/connectors", "github"],
      "env": {
        "GITHUB_PAT": "ghp_...",
        "NIMBUS_MCP_GITHUB_WRITE_SCOPE": "repo:acme/api",
        "NIMBUS_MCP_AUDIT_LOG": "/absolute/path/to/nimbus-mcp-audit.jsonl"
      }
    }
  }
}
```

Credentials come from the environment. There is no Vault outside the gateway, so whoever writes this
config holds the secret. Every variable, and the two behaviours that look like bugs and are not, are
in [Configuration](./docs/configuration.md).

Each connector documents its own tools and credentials at `connectors/<id>/README.md`.

## Documentation

| Page | Read it when |
| --- | --- |
| [Architecture](./docs/architecture.md) | You want the layout, or how a connector is put together. |
| [Client support](./docs/client-support.md) | Write tools are missing, or you need to know if your client can approve a mutation. |
| [Configuration](./docs/configuration.md) | You are wiring a connector into a client. |
| [Standalone launcher](./docs/standalone-launcher.md) | You want `nimbus-connector`: eligibility, exit codes, refusals. |
| [Adding a connector](./docs/adding-a-connector.md) | You are writing or changing a connector. |
| [Publishing](./docs/publishing.md) | You are cutting a release. |

## Development

```bash
bun install
bun run check   # lint, typecheck, consent audit, full suite
```

CI runs those four on Ubuntu, macOS and Windows — platform equality is a Nimbus non-negotiable.

## Relationship to the Nimbus monorepo

The connectors are developed here and consumed by the gateway from npm. The gateway's per-connector
**sync and indexing** intelligence stays in
[nimbus-agent/Nimbus](https://github.com/nimbus-agent/Nimbus) — this repo holds the MCP tool surface,
which is the part that is useful without a gateway. Adding a connector therefore touches both repos.

Not to be confused with [`nimbus-mcp`](https://github.com/nimbus-agent/nimbus-mcp), which exposes
your local Nimbus **index and agents** to an MCP client. This repo is the other direction: the
connectors that reach your tools.

## History

This repo was a scaffold from 2026-06-18 until the connectors landed. Its original README posed three
"decisions to make first" — share-vs-vendor-vs-fork, the credential model outside the Vault, and the
AGPL implications for downstream clients. All three were answered before the move: the connectors are
consent-gated standalone, credentials come from the environment, and `NOTICE` states the tiering. It
also proposed a package per connector; one package was chosen instead, because 94 packages means 94
releases and forces `shared/` to become a versioned dependency that 190 files import by relative path.

## License

[AGPL-3.0-only](./LICENSE), and [`NOTICE`](./NOTICE) records the security tiering — please preserve
it. "Nimbus" is a trademark of the Nimbus project; this licence grants no trademark rights, and a
modified version that removes these protections must not be described as Nimbus-grade.
