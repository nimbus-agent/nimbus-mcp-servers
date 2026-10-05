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

## The audit log

With `NIMBUS_MCP_AUDIT_LOG` set, each step of a write — `requested`, `accepted`, `declined`,
`refused`, `executed`, `failed` — is appended to that file as one line, linked by hash to the line
before it. One path can serve every connector you run, and the separate copies of a connector that
each client session starts: appends are serialised within a process, and across processes by a lock
file beside the log, `<path>.lock`. A path that is a symlink is followed first, so the lock sits
beside the file it points to. The directory holding the log must be writable, not only the file.

The log fails closed. A write runs only once its `requested` and `accepted` lines have been
appended, and one that cannot be recorded is refused: when the log's directory is missing, the log
cannot be read, its last line is not a complete entry, or its lock cannot be taken within 30
seconds. If recording fails after the tool has run, whether it succeeded or failed, the call
reports what the tool did as well, so it is not taken for a write that never started.

A lock left behind by a connector killed mid-append is taken over automatically: at once when its
process has exited and this connector can tell, otherwise once the lock is 10 seconds old. A
connector can tell only for a process on the same machine and, on Linux, in the same PID namespace.
A lock from a container or Flatpak sandbox with a PID namespace of its own, or from the other side
of WSL, waits out its 10 seconds, since a pid from there means nothing here. One writer at a time
takes a lock over, under a second lock, `<path>.lock.takeover`, that exists only while it does.

What the lock does not cover:

- **A writer stalled for more than 10 seconds** partway through an append has its lock taken over
  as abandoned. It checks that it still holds the lock just before it writes, so this can break the
  chain only when the takeover lands between that check and the write.
- **A second name for the log that is not a symlink** — a hard link, or a container mount of the
  log file alone rather than its directory — gives the writers using it a lock of their own. Mount
  the directory instead.
- **Several machines sharing one log** over a network share need distinct hostnames — on Windows
  and macOS the hostname is all that tells two machines apart — and clocks within 10 seconds of the
  file server's. Network filesystems are untested.
- **Windows and WSL processes writing one log on WSL's `/mnt` drives.** Those drives lose sight of
  a file for a moment while another process renames it. Measured with 4 Windows and 4 WSL writers,
  over 16,000 appends in 20 runs: every chain stayed intact, but 8 appends were reported as failed
  although their entry had been written, and in 5 runs a lock was left in place until it aged out,
  holding appends up for about 10 seconds. WSL writers alone ran cleanly there, 4,000 appends with
  none failed or held up. Give each side its own log.
- **Verifying the chain reads the log without the lock**, so a log that a connector is writing to
  can show a break at a line still being written. Verify a log nothing is writing to.

## Environment variables

| Variable | Meaning |
| --- | --- |
| `NIMBUS_MCP_<SERVICE>_WRITE_SCOPE` | Comma-separated `kind:value` terms, e.g. `repo:acme/api`. **Unset authorises nothing** — it never means unrestricted. A term matches one target exactly: `repo:acme/api` does not cover `acme/api-secrets`. The kinds a connector accepts are named in the warning it prints when the variable is unset, and a term of any other kind stops it at startup with the same list. |
| `NIMBUS_MCP_WRITE_BUDGET` | Maximum mutations per session. Caps a runaway agent loop, including one that sends its writes in parallel: a write whose prompt you approve after the budget has run out is still refused. Unset means the default, `10`. A value you set must be a whole number in plain digits, from `0`, which refuses every write, to `9007199254740991`; whitespace around it is ignored. Any other value stops a connector that has write tools at startup, with an error naming the variable: an empty or whitespace-only value, a sign as in `-1` or `+5`, a decimal point as in `2.5` or `10.0`, `1e3`, `0x10`, `ten`, `Infinity`, or a number above `9007199254740991`. It is never replaced by the default, which could be more than you meant. |
| `NIMBUS_MCP_AUDIT_LOG` | Absolute path for the hash-chained JSONL audit log. Unset disables it, and it is the only record the connector keeps of its write calls: no MCP log messages are sent to the client. |
| _connector credentials_ | Per connector, e.g. `GITHUB_PAT`. Most are listed in `connectors/<id>/README.md`; where a README does not list them yet, a tool called without its credential refuses with an error naming the variable. |

`<SERVICE>` is the connector id you launch, upper-cased, with each `-` written as `_`: `github`
reads `NIMBUS_MCP_GITHUB_WRITE_SCOPE` and `monte-carlo` reads `NIMBUS_MCP_MONTE_CARLO_WRITE_SCOPE`.
Do not derive it from a connector's tool names or action types — `monte-carlo`'s are
`montecarlo_*` and `montecarlo.*`. A variable under any other name is ignored, not rejected.

## Three behaviours that look like bugs and are not

**No write tools appear.** Your client does not advertise the MCP `elicitation` capability, so there
is no way to obtain consent and the tools are not offered at all. Reads work normally. **On Claude
Desktop this is the expected state today.** The moment your client ships elicitation support, the
same connector version gains its write tools.

**Every write refuses with "out of scope".** `NIMBUS_MCP_<SERVICE>_WRITE_SCOPE` is unset, or the
scope is set under a name the connector does not read. An empty scope authorises nothing. The
server prints a warning to stderr at startup saying exactly this, naming the variable it reads. An
`argocd` scope carried over from 0.2.1 or earlier is this case: see [Upgrading](#upgrading).

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

## Upgrading

Each entry is something a standalone setup has to change when it moves to that release. Changes
that need nothing from you are only in the [changelog](../CHANGELOG.md).

### To 0.2.3

**The audit log's directory must be writable.** Releases up to 0.2.2 needed only the log file to
be writable. If yours sits in a directory the connector cannot write to, every write tool now
refuses until you move the log or make its directory writable. Upgrade every client's connectors
together, too: a connector from 0.2.2 or earlier appends without the lock, and can still break the
chain for the others.

**`NIMBUS_MCP_WRITE_BUDGET` accepts only plain digits.** Anything else now stops a connector that
has write tools from starting, read tools included: an empty value, a sign (`-1`, `+5`), a
fraction (`10.0`), an exponent (`1e3`), a hex value (`0x10`) or a word. Earlier releases read
those as a number, or a word as no limit at all. Unset it for the default of 10, or set a whole
number, where 0 refuses every write.

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
- Elsewhere a call must first match a scope term, and the session must have write budget left.
  Only then does it ask for your approval, and only an approved call spends one unit of
  `NIMBUS_MCP_WRITE_BUDGET`. The unit is spent before the tool runs, so a call that fails
  still uses it. The scope terms are `instance:<instanceIds>` in `NIMBUS_MCP_AWS_WRITE_SCOPE`,
  `user:<user_ids>` in `NIMBUS_MCP_SLACK_WRITE_SCOPE`, or `chat:<chatId>` in
  `NIMBUS_MCP_TEAMS_WRITE_SCOPE`. The
  `instance` and `user` kinds are new in 0.2.2, so no AWS or Slack scope written for an earlier
  version covers these tools.
- A term must equal the argument exactly as the tool receives it, and terms are separated by
  commas, so an `instanceIds` or `user_ids` value that lists several IDs with commas never matches:
  that call always refuses.

All of this is standalone behaviour. Under the Nimbus gateway the connector registers these tools
as before and does not enforce the write scope. It still parses the scope at startup, so a
malformed term stops the connector from starting there too.
