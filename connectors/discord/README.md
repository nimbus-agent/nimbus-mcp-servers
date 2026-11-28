# Discord Connector

## What this is

First-party Nimbus MCP connector for Discord, acting as a bot. It lets the Nimbus agent list the
guilds the bot is in, their channels and active threads, read recent channel messages, and post a
message to one channel as the bot.

## Install

Bundled with Nimbus — no separate install required.

## Quickstart

```bash
nimbus connector auth discord --token <your-bot-token> --enable
nimbus ask "Summarize my recent activity in Discord"
```

The gateway injects the credential as an environment variable at spawn time; the connector itself
never touches the vault.

| Variable | Required | Purpose |
| --- | --- | --- |
| `DISCORD_BOT_TOKEN` | yes | The bot token, sent as `Authorization: Bot <token>`. Read on every call. |

Requests go to `https://discord.com/api/v10`. Guild and channel ids are URL-encoded into the path,
and the `after` cursor is passed as a query parameter.

Tools exposed:

| Tool | Purpose |
| --- | --- |
| `discord_guild_list` | List the guilds the bot is a member of. |
| `discord_channel_list` | List the channels of `guildId` (id, type, name). |
| `discord_channel_messages` | List recent messages in `channelId`, newest first: `limit` 1-100 (default 50), optional `after` snowflake for an incremental fetch. |
| `discord_thread_list` | List the active threads of `guildId`, including public threads the bot can see. |
| `discord_message_post` (write) | Post `content` (1-2000 characters) to `channelId` (a snowflake of 17-20 digits) as the bot. Returns the new message's `id`. |

### The writes

`discord_message_post` is the only write, and it registers through `createWriteToolRegistrar`. It
posts a message to one channel **as the bot**, not as a person. Only user mentions are active in it
(`allowed_mentions.parse` is `["users"]`): `@everyone`, `@here` and role mentions arrive as plain
text. The registration declares it recoverable: the post is the whole effect and its id is
returned, although it cannot be unsent from here.

Standalone, it is offered only to a client that can ask you, it asks before every post, and it is
limited by a write scope naming the channel (the only kind is `channel`; a term is `channel:<id>`
and matches exactly):

```bash
NIMBUS_MCP_DISCORD_WRITE_SCOPE=channel:123456789012345678
```

The bot needs the Send Messages permission in that channel. Inside the Nimbus gateway the executor's
own approval prompt is the gate and the scope is not read.

## See also

- [Nimbus Connectors Overview](https://nimbus-agent.dev/user-guide/connectors/)
- [Nimbus Architecture Overview](https://nimbus-agent.dev/architecture-overview/)
- [HITL and Safety](https://nimbus-agent.dev/user-guide/hitl-and-safety/)

## License

AGPL-3.0
