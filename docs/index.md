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

Two files at the repository root are documentation in their own right and are deliberately not
duplicated here:

- [`NOTICE`](../NOTICE) — the security tiering, and what running standalone does **not** give you.
  The licence asks that it be preserved.
- [`LICENSE`](../LICENSE) — AGPL-3.0-only.

Each connector also carries its own `README.md` at `connectors/<id>/README.md`, documenting that
connector's tools, credentials and scopes. Those stay beside the code they describe.
