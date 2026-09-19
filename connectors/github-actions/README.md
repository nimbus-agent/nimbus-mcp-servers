# Github Actions Connector

## What this is

Nimbus MCP connector for Github Actions. Indexes and provides context from Github Actions to the Nimbus agent.

## Install

Bundled with Nimbus — no separate install required.

## Quickstart

GitHub Actions reuses the GitHub connector's personal access token (`github.pat`);
there is no separate GitHub Actions credential, and `nimbus connector auth github-actions`
does not work.

```bash
nimbus connector auth github --token <your-github-pat>
nimbus ask "Summarize my recent activity in Github Actions"
```

## See also

- [Github Actions Connector Documentation](https://nimbus-agent.dev/user-guide/connectors/)
- [Nimbus Architecture Overview](https://nimbus-agent.dev/architecture-overview/)
- [HITL and Safety](https://nimbus-agent.dev/user-guide/hitl-and-safety/)

## License

AGPL-3.0
