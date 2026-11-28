# Teams Connector

## What this is

First-party Nimbus MCP connector for Microsoft Teams. It gives the Nimbus agent read access to the
user's teams, channels, chats and their messages through Microsoft Graph, and three guarded writes:
a post to a channel, a post to a chat, and a ChatOps bot reply.

## Install

Bundled with Nimbus — no separate install required.

## Quickstart

```bash
nimbus connector auth teams
nimbus ask "Summarize my recent activity in Teams"
```

The gateway injects credentials as environment variables at spawn time; the connector itself never
touches the vault.

| Variable | Required | Purpose |
| --- | --- | --- |
| `MICROSOFT_OAUTH_ACCESS_TOKEN` | yes, for every tool except `teams_chat_post` | The Microsoft Graph OAuth access token of the signed-in user, sent as a Bearer token. Read on every call. |
| `TEAMS_BOT_APP_ID` | for `teams_chat_post` | The bot's app (client) id, used to obtain an app-only Bot Framework token from `login.microsoftonline.com`. |
| `TEAMS_BOT_APP_PASSWORD` | for `teams_chat_post` | The bot's client secret for that token request. |
| `TEAMS_BOT_SERVICE_URL` | no | The Bot Framework service URL that conversation activities are posted to. Default `https://smba.trafficmanager.net/teams/`; a trailing slash is added if missing. |

Graph requests go to `https://graph.microsoft.com/v1.0`. A `nextLink` argument is resolved through
`resolveUrlWithBase`, which refuses any origin other than Graph's before the token is sent.

Tools exposed:

| Tool | Purpose |
| --- | --- |
| `teams_team_list` | List the teams the signed-in user has joined: `top` 1-100 (default 50), or a `nextLink`. |
| `teams_channel_list` | List the channels of `teamId`: `top` 1-100 (default 50), or a `nextLink`. |
| `teams_channel_messages` | List recent messages in a channel (`teamId`, `channelId`; not a delta query): `top` 1-50 (default 25), or a `nextLink`. |
| `teams_chat_list` | List the user's 1:1 and group chats: `top` 1-50 (default 25), or a `nextLink`. |
| `teams_chat_messages` | List messages in the chat `chatId`: `top` 1-50 (default 25), or a `nextLink`. |
| `teams_user_info` | Fetch one user by `userId` (`/users/{id}`), including mail and user principal name, for ChatOps identity mapping. |
| `teams_message_post` (write) | Post to a team channel (`teamId`, `channelId`, `body`, `contentType` `text` (default) or `html`). |
| `teams_message_post_chat` (write) | Post to a chat (`chatId`, `body`, `contentType` `text` (default) or `html`). |
| `teams_chat_post` (write) | Post a bot message to a conversation (`conversationId`, `text`, optional `attachments`) as the bot, using the bot app credentials rather than the user's Graph token. |

### ChatOps adaptive cards

`teams_chat_post` (the bot reply surface) takes an optional `attachments` array of exactly one
`{ contentType: "application/vnd.microsoft.card.adaptive", content: <card object> }`, at most 28 KiB
serialised. It is sent in the Bot Framework activity unchanged; when absent the activity is plain
text as before.

### The writes

All three register through `createWriteToolRegistrar`, and each is registered as recoverable.
Standalone, that adds the consent prompt, the write scope, the mutation budget and the audit
record; inside the gateway the executor's approval is the gate. The standalone scope variable is
`NIMBUS_MCP_TEAMS_WRITE_SCOPE`, with kinds `channel` and `chat`. A term is `kind:value` and matches
exactly, with no prefix matching.

- `teams_message_post` posts to a channel as the signed-in user. Scope: `channel:<teamId>/<channelId>`.
- `teams_message_post_chat` posts to a chat as the signed-in user. Scope: `chat:<chatId>`.
- `teams_chat_post` posts as the bot. Scope: `chat:<conversationId>`.

## See also

- [Nimbus Connectors Overview](https://nimbus-agent.dev/user-guide/connectors/)
- [Nimbus Architecture Overview](https://nimbus-agent.dev/architecture-overview/)
- [HITL and Safety](https://nimbus-agent.dev/user-guide/hitl-and-safety/)

## License

AGPL-3.0
