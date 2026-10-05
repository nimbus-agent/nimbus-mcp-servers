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

The write-scope and write-budget variables only take effect on a client that can show a consent
prompt: on a client without `elicitation` the write tools never register, so a valid value changes
nothing there — see [Client support](./client-support.md). Both are still read when a connector
that has write tools starts, though, so a malformed value stops that connector on every client,
its read tools included.

## Environment variables

| Variable | Meaning |
| --- | --- |
| `NIMBUS_MCP_<SERVICE>_WRITE_SCOPE` | Comma-separated `kind:value` terms, e.g. `repo:acme/api`. **Unset authorises nothing** — it never means unrestricted. A term matches one target exactly: `repo:acme/api` does not cover `acme/api-secrets`. The kinds a connector accepts are named in the warning it prints when the variable is unset, and a term of any other kind stops it at startup with the same list. |
| `NIMBUS_MCP_WRITE_BUDGET` | Maximum mutations per session. Caps a runaway agent loop, including one that sends its writes in parallel: a write whose prompt you approve after the budget has run out is still refused. Unset means the default, `10`. A value you set must be a whole number in plain digits, from `0`, which refuses every write, to `9007199254740991`; whitespace around it is ignored. Any other value stops a connector that has write tools at startup, with an error naming the variable: an empty or whitespace-only value, a sign as in `-1` or `+5`, a decimal point as in `2.5` or `10.0`, `1e3`, `0x10`, `ten`, `Infinity`, or a number above `9007199254740991`. It is never replaced by the default, which could be more than you meant. |
| `NIMBUS_MCP_AUDIT_LOG` | Absolute path for the hash-chained JSONL audit log. Unset disables the durable log; the client-visible log messages are always sent. |
| _connector credentials_ | Per connector, e.g. `GITHUB_PAT`. Most are listed in `connectors/<id>/README.md`; where a README does not list them yet, a tool called without its credential refuses with an error naming the variable. |

## Three behaviours that look like bugs and are not

**No write tools appear.** Your client does not advertise the MCP `elicitation` capability, so there
is no way to obtain consent and the tools are not offered at all. Reads work normally. **On Claude
Desktop this is the expected state today.** The moment your client ships elicitation support, the
same connector version gains its write tools.

**Every write refuses with "out of scope".** `NIMBUS_MCP_<SERVICE>_WRITE_SCOPE` is unset. An empty
scope authorises nothing. The server prints a warning to stderr at startup saying exactly this.

**On Windows, an `azure` or `gcp` call answers "refused to run … it may start a Windows batch
file".** `az` and `gcloud` are batch files on Windows, and `cmd.exe` parses a batch file's arguments
a second time, so an argument holding `% ! " & | < > ^ ( )` or a line break could run a command or
expand an environment variable into it. The connector refuses such an argument instead, before
anything runs. Resource names do not hold these characters: an Azure resource group may hold
parentheses, but `az.cmd` could never take one, since a resource group has no space and so is never
quoted. An Azure subscription given by a display name that holds one is refused — pass its id. The
same applies to any CLI whose first match on `PATH` is a `.cmd` or `.bat`, such as a pip-installed
`aws` v1 ahead of the v2 installer's `aws.exe`, where it refuses a CloudFormation template body;
with the `aws.exe` first, nothing is refused.

## Optional dependencies

Four connectors need libraries the other 90 do not: `apple` (`imapflow`, `nodemailer`, `tsdav`),
`imap` and `protonmail` (`imapflow`, `nodemailer`), and `dataprofile` (`hyparquet`). They are
declared as **optional** dependencies, so a normal install fetches them and all 94 connectors work
out of the box, while a platform that cannot build one does not break the other 93.

If you install with optional dependencies disabled, those four fail at startup with a
module-not-found error. The rest are unaffected.
