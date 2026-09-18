# Obsidian Connector

## What this is

Nimbus MCP connector for Obsidian. Indexes and provides context from Obsidian to the Nimbus agent.

## Install

Bundled with Nimbus — no separate install required.

## Quickstart

Obsidian has no credential: `nimbus connector auth obsidian` does not work. The
Gateway discovers vaults (directories containing `.obsidian/`) under the
`[[filesystem.roots]]` entries in your `nimbus.toml`:

```toml
[[filesystem.roots]]
path = "~/Documents/MyVault"
```

```bash
nimbus ask "Summarize my recent activity in Obsidian"
```

## See also

- [Obsidian Connector Documentation](https://nimbus-agent.dev/user-guide/connectors/)
- [Nimbus Architecture Overview](https://nimbus-agent.dev/architecture-overview/)
- [HITL and Safety](https://nimbus-agent.dev/user-guide/hitl-and-safety/)

## License

AGPL-3.0
