# Configuration

Credentials come from the environment. **There is no Vault outside the Nimbus gateway**, so whoever
writes this config holds the secret in plaintext. That is the central trade-off of running a
connector standalone; see [`NOTICE`](../NOTICE).

## Client config

The shape is the same for Claude Code, Cursor and Claude Desktop.

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

The write-scope variable is only consulted by a client that can show a consent prompt. On a client
without `elicitation` it is harmless and unused, because the write tools never register — see
[Client support](./client-support.md).

## Environment variables

| Variable | Meaning |
| --- | --- |
| `NIMBUS_MCP_<SERVICE>_WRITE_SCOPE` | Comma-separated `kind:value` terms, e.g. `repo:acme/api`. **Unset authorises nothing** — it never means unrestricted. |
| `NIMBUS_MCP_WRITE_BUDGET` | Maximum mutations per session. Defaults to `10`. Caps a runaway agent loop. |
| `NIMBUS_MCP_AUDIT_LOG` | Absolute path for the hash-chained JSONL audit log. Unset disables the durable log; the client-visible log messages are always sent. |
| _connector credentials_ | Per connector, e.g. `GITHUB_PAT`. See `connectors/<id>/README.md`. |

## Two behaviours that look like bugs and are not

**No write tools appear.** Your client does not advertise the MCP `elicitation` capability, so there
is no way to obtain consent and the tools are not offered at all. Reads work normally. **On Claude
Desktop this is the expected state today.** The moment your client ships elicitation support, the
same connector version gains its write tools.

**Every write refuses with "out of scope".** `NIMBUS_MCP_<SERVICE>_WRITE_SCOPE` is unset. An empty
scope authorises nothing. The server prints a warning to stderr at startup saying exactly this.

## Optional dependencies

Four connectors need libraries the other 90 do not: `apple` (`imapflow`, `nodemailer`, `tsdav`),
`imap` and `protonmail` (`imapflow`, `nodemailer`), and `dataprofile` (`hyparquet`). They are
declared as **optional** dependencies, so a normal install fetches them and all 94 connectors work
out of the box, while a platform that cannot build one does not break the other 93.

If you install with optional dependencies disabled, those four fail at startup with a
module-not-found error. The rest are unaffected.
