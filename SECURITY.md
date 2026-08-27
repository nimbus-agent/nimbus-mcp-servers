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
- **The mutation budget.** `NIMBUS_MCP_WRITE_BUDGET` caps mutations per session.
- **Credential handling.** Credentials come from the environment and must never appear in a tool
  result, a log line, or an error message.
- **Argument handling.** A connector that shells out must not let a tool argument smuggle a flag or
  escape into the command — see `shared/safe-cli-arg.ts`.

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
