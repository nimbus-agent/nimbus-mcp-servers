# Configuration

Credentials come from the environment. **There is no Vault outside the Nimbus gateway**, so whoever
writes this config holds the secret in plaintext. That is the central trade-off of running a
connector standalone; see [`NOTICE`](../NOTICE).

## Client config

The shape is the same for Claude Code, Cursor and Claude Desktop. `npx` needs
[Bun](https://bun.sh) 1.2 or newer on the `PATH` the client launches it with: the package ships
TypeScript, and its `nimbus-connector` bin runs under Bun.

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
without `elicitation` it is unused, because the write tools never register — see
[Client support](./client-support.md). It is still parsed at startup, though, so a term the
connector cannot parse stops it there too, reads included.

## Environment variables

| Variable | Meaning |
| --- | --- |
| `NIMBUS_MCP_<SERVICE>_WRITE_SCOPE` | Comma-separated `kind:value` terms, e.g. `repo:acme/api`. **Unset authorises nothing** — it never means unrestricted. A term matches one target exactly: `repo:acme/api` does not cover `acme/api-secrets`. The kinds a connector accepts are named in the warning it prints when the variable is unset, and a term of any other kind stops it at startup with the same list. |
| `NIMBUS_MCP_WRITE_BUDGET` | Maximum mutations per session. Defaults to `10`. Caps a runaway agent loop. |
| `NIMBUS_MCP_AUDIT_LOG` | Absolute path for the hash-chained JSONL audit log. Unset disables it, and it is the only record the connector keeps of its write calls: no MCP log messages are sent to the client. |
| _connector credentials_ | Per connector, e.g. `GITHUB_PAT`. Most are listed in `connectors/<id>/README.md`; where a README does not list them yet, a tool called without its credential refuses with an error naming the variable. |

`<SERVICE>` is the connector id you launch, upper-cased, with each `-` written as `_`: `github`
reads `NIMBUS_MCP_GITHUB_WRITE_SCOPE` and `monte-carlo` reads `NIMBUS_MCP_MONTE_CARLO_WRITE_SCOPE`.
Do not derive it from a connector's tool names or action types — `monte-carlo`'s are
`montecarlo_*` and `montecarlo.*`. A variable under any other name is ignored, not rejected.

## Two behaviours that look like bugs and are not

**No write tools appear.** Your client does not advertise the MCP `elicitation` capability, so there
is no way to obtain consent and the tools are not offered at all. Reads work normally. **On Claude
Desktop this is the expected state today.** The moment your client ships elicitation support, the
same connector version gains its write tools.

**Every write refuses with "out of scope".** `NIMBUS_MCP_<SERVICE>_WRITE_SCOPE` is unset, or the
scope is set under a name the connector does not read. An empty scope authorises nothing. The
server prints a warning to stderr at startup saying exactly this, naming the variable it reads. An
`argocd` scope carried over from 0.2.1 or earlier is this case: see [Upgrading](#upgrading).

## Optional dependencies

Four connectors need libraries the other 90 do not: `apple` (`imapflow`, `nodemailer`, `tsdav`),
`imap` and `protonmail` (`imapflow`, `nodemailer`), and `dataprofile` (`hyparquet`). They are
declared as **optional** dependencies, so a normal install fetches them and all 94 connectors work
out of the box, while a platform that cannot build one does not break the other 93.

If you install with optional dependencies disabled, those four fail at startup with a
module-not-found error. The rest are unaffected.

## Upgrading

Each entry is something a standalone setup has to change when it moves to that release. Changes
that need nothing from you are only in the [changelog](../CHANGELOG.md).

### To 0.2.2

**`argocd` reads a different write-scope variable.** From 0.2.2 the connector reads
`NIMBUS_MCP_ARGOCD_WRITE_SCOPE`; earlier versions read `NIMBUS_MCP_APP_WRITE_SCOPE` by mistake, so
rename it. The value does not change. The old name is ignored, not read as a fallback: if it is the
only one you set, `argocd_app_sync` and `argocd_app_rollback` refuse every call as out of scope
until you rename it, and the connector warns at startup that `NIMBUS_MCP_ARGOCD_WRITE_SCOPE` is
unset. If you also set `NIMBUS_MCP_ARGOCD_WRITE_SCOPE` before 0.2.2, it was ignored then and takes
effect now, with no warning: check its value, then delete `NIMBUS_MCP_APP_WRITE_SCOPE`.

**Four tools now ask for consent.** `aws_ec2_instance_stop` and `aws_ec2_instance_start` stop and
start EC2 instances, and `slack_message_post_dm` and `teams_message_post_chat` send messages, but
earlier versions registered all four as reads: every client was offered them, with no consent
prompt, scope check, budget or audit record. From 0.2.2 they are write tools like the rest:

- A client without `elicitation`, such as Claude Desktop, no longer sees them.
- Elsewhere each call needs your approval, counts against `NIMBUS_MCP_WRITE_BUDGET`, and must first
  match a scope term: `instance:<instanceIds>` in `NIMBUS_MCP_AWS_WRITE_SCOPE`, `user:<user_ids>`
  in `NIMBUS_MCP_SLACK_WRITE_SCOPE`, or `chat:<chatId>` in `NIMBUS_MCP_TEAMS_WRITE_SCOPE`. The
  `instance` and `user` kinds are new in 0.2.2, so no AWS or Slack scope written for an earlier
  version covers these tools.
- A term must equal the argument exactly as the tool receives it, and terms are separated by
  commas, so an `instanceIds` or `user_ids` value that lists several IDs with commas never matches:
  that call always refuses.

All of this is standalone behaviour. Under the Nimbus gateway the connector registers these tools
as before and never consults the write scope.
