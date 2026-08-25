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
supply them. See [`NOTICE`](./NOTICE) for the security tiering that notice asks you to preserve.

## Client support — writes depend on your client

Reads work everywhere. **Writes require your client to implement the MCP `elicitation` capability**,
because that is the only way a server can put a consent prompt in front of you. Without it, write
tools are **not registered at all** rather than offered ungated — deliberate, not a defect: a tool
the model cannot see is a tool it cannot call without a human.

**This table is a dated observation, not a standing guarantee.** Client support changes between
releases, so the version tested is part of the claim.

| Client | Version tested | `elicitation` | Basis | You get |
| --- | --- | --- | --- | --- |
| **Claude Desktop** | 1.34493.1 (MSIX) | **no** | **observed** | **reads only** |
| Claude Code | not tested | yes — form + URL | vendor docs | reads and writes |
| Cursor | not tested | yes, since v1.5 | vendor changelog | reads and writes |
| Anything else | — | check it | — | reads, plus writes if it advertises `elicitation` |

Measured 2026-08-24 against the `github` connector, which exposes 9 read tools and 5 write tools. A
client that supports elicitation is served **14** tools; Claude Desktop was served **9**, with
`github_pr_merge`, `github_branch_delete`, `github_issue_create`, `github_pr_close` and
`github_tag_create` correctly absent.

**Checking your own client** takes one query: ask it to list the connector's tools. If the write
tools are absent, your client does not implement elicitation.

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
config holds the secret.

| Variable | Meaning |
| --- | --- |
| `NIMBUS_MCP_<SERVICE>_WRITE_SCOPE` | Comma-separated `kind:value` terms, e.g. `repo:acme/api`. Unset authorises nothing. |
| `NIMBUS_MCP_WRITE_BUDGET` | Maximum mutations per session. Defaults to `10`. |
| `NIMBUS_MCP_AUDIT_LOG` | Absolute path for the hash-chained JSONL audit log. |
| _connector credentials_ | Per connector, e.g. `GITHUB_PAT`. |

### Optional dependencies

Four connectors need libraries the other 90 do not: `apple` (`imapflow`, `nodemailer`, `tsdav`),
`imap` and `protonmail` (`imapflow`, `nodemailer`), and `dataprofile` (`hyparquet`). They are
declared as **optional** dependencies, so a normal install fetches them and all 94 connectors work
out of the box, while a platform that cannot build one does not break the other 93. If you install
with optional dependencies disabled, those four fail at startup with a module-not-found error; the
rest are unaffected.

### Two behaviours that look like bugs and are not

**No write tools appear.** Your client does not advertise `elicitation`, so there is no way to obtain
consent and the tools are not offered at all. Reads work normally. **On Claude Desktop this is the
expected state today.**

**Every write refuses with "out of scope".** `NIMBUS_MCP_<SERVICE>_WRITE_SCOPE` is unset. An empty
scope authorises nothing — unset never means unrestricted.

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
