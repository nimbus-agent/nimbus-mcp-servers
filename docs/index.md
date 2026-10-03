# Documentation

The repository README is the front door — what these connectors are, and how to run one. These
pages are the detail behind it.

| Page | Read it when |
| --- | --- |
| [Architecture](./architecture.md) | You want the repository layout, or how a connector is put together. |
| [Client support](./client-support.md) | Write tools are missing, or you need to know whether your MCP client can approve a mutation. |
| [Configuration](./configuration.md) | You are wiring a connector into a client: credentials, write scopes, the audit log. |
| [Standalone launcher](./standalone-launcher.md) | You want the `nimbus-connector` entry point: eligibility, exit codes, refusal behaviour. |
| [Adding a connector](./adding-a-connector.md) | You are writing a new connector or changing an existing one. |
| [Publishing](./publishing.md) | You are cutting a release of `@nimbus-dev/connectors`. |

Four files at the repository root are documentation in their own right and are deliberately not
duplicated here:

- [`NOTICE`](../NOTICE) — the security tiering, and what running standalone does **not** give you.
  The licence asks that it be preserved.
- [`LICENSE`](../LICENSE) — AGPL-3.0-only.
- [`CONTRIBUTING.md`](../CONTRIBUTING.md) — how to work in this repo, and the rules that are not
  preferences.
- [`SECURITY.md`](../SECURITY.md) — how to report a vulnerability, and what is in scope. The
  out-of-scope half matters most: there is no Vault, sandbox or egress ledger here.

Each connector also carries its own `README.md` at `connectors/<id>/README.md`, beside the code it
describes. Most document that connector's tools and credentials; some are still only a short
gateway quickstart, and [Configuration](./configuration.md) says how to find a credential they
leave out.
