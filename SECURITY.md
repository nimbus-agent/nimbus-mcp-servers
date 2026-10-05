# Security Policy

`@nimbus-dev/connectors` is the AGPL-3.0-only package of Nimbus first-party MCP connectors. Each
connector is an MCP server over stdio that reaches a third-party API with credentials supplied from
the environment.

## Reporting a vulnerability

- Use GitHub's [private vulnerability reporting](https://github.com/nimbus-agent/nimbus-mcp-servers/security/advisories/new).
- Do **not** open a public issue for a suspected vulnerability.
- Include the connector id, the tool involved, and what an attacker could reach.

## What is in scope

The properties this package claims, and therefore the ones a report can be filed against:

- **Consent before every mutation.** A write tool is registered only through
  `shared/consent-kit.ts`'s `createWriteToolRegistrar`, which asks the client to put the exact
  operation in front of a human. A mutating tool reachable without that is a vulnerability.
- **The write-scope allow-list.** `NIMBUS_MCP_<SERVICE>_WRITE_SCOPE` is enforced server-side and is
  unreachable by the model. Unset authorises nothing; a write that proceeds on an empty scope is a
  vulnerability.
- **The mutation budget.** `NIMBUS_MCP_WRITE_BUDGET` caps mutations per session, `10` when unset.
  A value that is set must be a whole number in plain digits, from `0`, which refuses every write,
  to `9007199254740991`, with any whitespace around it ignored. Any other value, an empty one
  included, stops a connector that has write tools at startup rather than running it under some
  other cap. A mutation past the budget, or any mutation while the variable holds a value outside
  that rule, is a vulnerability.
- **Credential handling.** Credentials come from the environment and must never appear in a tool
  result, a log line, or an error message.
- **Argument handling.** A connector that drives a CLI spawns it with an argv array and no shell,
  and a tool argument must reach the CLI as the value it was meant to be. Three rules make that
  hold, each enforced before anything runs:
  - a value starting with `-` is refused, since the CLI would read it as a flag: a pod named
    `--kubeconfig=<path>` would load that kubeconfig, whose exec credential plugin runs a command;
  - a value the CLI would replace by reading something else is refused — `file://`, `fileb://`,
    `http://`, `https://` or the shorthand operator `@=` for `aws`, a leading `@` or `=@` for `az` —
    since what it read would be sent to the cloud API, and an error could quote it back;
  - on Windows, where `az` and `gcloud` are batch files that `cmd.exe` parses a second time, the
    spawn itself refuses an argument holding `% ! " & | < > ^ ( )` or a control character whenever
    the program may be a `.cmd` or `.bat` — the file its name is found as first on `PATH`, looked up
    as the runtime looks it up — since those would run a second command or expand an environment
    variable into the argument.

  The first two are the argument schemas in `shared/cli-json-kit.ts`, from the rules in
  `shared/safe-cli-arg.ts`; the third is `shared/windows-batch-args.ts`, applied by
  `shared/nimbus-spawn.ts`, the only file that starts a process. A tool argument that reaches a CLI
  past them, or a process started anywhere else, is a vulnerability.

## What is NOT in scope

Stated plainly, because the difference is the whole point of [`NOTICE`](./NOTICE):

- **There is no Vault here.** Credentials live in the environment, so whoever writes the MCP client
  config holds them in plaintext. That is a property of running standalone, not a defect.
- **There is no process sandbox, egress ledger, or owner-controlled consent.** Those belong to the
  Nimbus gateway and no published package can supply them.
- **A client that does not implement MCP `elicitation`** is served read tools only. That is the
  designed behaviour — a tool the model cannot see is one it cannot call without a human.

If a report depends on one of the above, it is a documentation question rather than a
vulnerability, and an issue is the right place for it.
