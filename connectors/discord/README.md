# Discord Connector

## What this is

Nimbus MCP connector for Discord. Indexes and provides context from Discord to the Nimbus agent.

## Install

Bundled with Nimbus — no separate install required.

## Quickstart

```bash
nimbus connector auth discord --token <your-bot-token> --enable
nimbus ask "Summarize my recent activity in Discord"
```

## Writes

`discord_message_post` posts a message to one channel **as the bot**, not as a person. Only user
mentions are active in it (`allowed_mentions.parse` is `["users"]`): `@everyone`, `@here` and role
mentions arrive as plain text. Standalone, it is offered only to a client that can ask you, it asks
before every post, and it is limited by a write scope naming the channel:

```bash
NIMBUS_MCP_DISCORD_WRITE_SCOPE=channel:123456789012345678
```

The bot needs the Send Messages permission in that channel. Inside the Nimbus gateway the executor's
own approval prompt is the gate and the scope is not read.

## See also

- [Discord Connector Documentation](https://nimbus-agent.dev/user-guide/connectors/)
- [Nimbus Architecture Overview](https://nimbus-agent.dev/architecture-overview/)
- [HITL and Safety](https://nimbus-agent.dev/user-guide/hitl-and-safety/)

## License

AGPL-3.0
