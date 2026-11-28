# Slack Connector

## What this is

First-party Nimbus MCP connector for Slack. It reads channels, threads, direct messages, users and
workspace search with a user token (`slack_channel_list`, `slack_channel_history`,
`slack_thread_replies`, `slack_dm_list`, `slack_dm_history`, `slack_user_list`, `slack_user_get`,
`slack_search`). It posts messages with the user token (`slack_message_post`,
`slack_message_post_dm`). It also carries the ChatOps surface, which uses bot and app tokens
(`slack_user_info`, `slack_chat_post`, `slack_views_open`, `slack_socket_open`). Useful for finding
the conversation behind an incident and for replying in it.

Indexes and provides context from Slack to the Nimbus agent.

## Install

Bundled with Nimbus — no separate install required.

## Quickstart

```bash
nimbus connector auth slack
nimbus ask "Summarize my recent activity in Slack"
```

The gateway injects the credentials as environment variables at spawn time; the connector itself
never touches the vault. Each is read when a tool that needs it runs, so a missing one fails only
that tool.

| Variable | Required | Purpose |
| --- | --- | --- |
| `SLACK_USER_ACCESS_TOKEN` | for the user-token tools | Used by every read tool and by `slack_message_post` and `slack_message_post_dm`. |
| `SLACK_BOT_TOKEN` | for the ChatOps tools | Used by `slack_user_info`, `slack_chat_post` and `slack_views_open`. |
| `SLACK_APP_TOKEN` | for Socket Mode | The app-level token used by `slack_socket_open`. |

All three are sent as `Authorization: Bearer <token>`. There are no defaults.

Every call is a JSON `POST` to `https://slack.com/api/<method>`; the host is fixed in code. A reply
is a failure unless Slack says `ok: true`, and the error quotes the first 400 characters of Slack's
answer.

Tools exposed:

| Tool | Purpose |
| --- | --- |
| `slack_channel_list` | List conversations (`conversations.list`), archived ones excluded. `types` defaults to `public_channel,private_channel,mpim,im`; `limit` 1 to 200 (default 200); `cursor`. |
| `slack_channel_history` | Fetch a channel, DM or mpim's messages (`conversations.history`). `channel`; `limit` 1 to 200 (default 50); `cursor`, `oldest`, `inclusive`. |
| `slack_thread_replies` | Fetch a thread (`conversations.replies`) by `channel` and parent `ts`; `limit` 1 to 200 (default 50); `cursor`. |
| `slack_dm_list` | List direct-message conversations (`im` and `mpim`, archived excluded); `limit` 1 to 200 (default 200); `cursor`. |
| `slack_dm_history` | The same call and arguments as `slack_channel_history`, as a convenience alias for DMs. |
| `slack_user_list` | List workspace users (`users.list`); `limit` 1 to 200 (default 100); `cursor`. |
| `slack_user_get` | Get one user's profile by `user` id (`users.info`, user token). |
| `slack_search` | Workspace message search (`search.messages`) for `query`; `count` 1 to 100 (default 20), `page` (default 1), `sort` (`timestamp` or `score`), `sort_dir` (`asc` or `desc`). |
| `slack_message_post` (write) | Post `text` to a `channel`, optionally in a thread (`thread_ts`), with the user token (`chat.postMessage`). |
| `slack_message_post_dm` (write) | Open or find a DM with `user_ids` (`conversations.open`) and send `text` to it, with the user token. |
| `slack_user_info` | Fetch a user's profile, including email, by `user` id with the bot token, for ChatOps identity mapping. |
| `slack_chat_post` (write) | Post an operational bot message to a `channel` with the bot token; `text` plus optional Block Kit `blocks`. |
| `slack_views_open` (write) | Open a confirmation modal (`views.open`) for a `trigger_id` and a `view` of type `modal`, with the bot token. |
| `slack_socket_open` | Open a Socket Mode connection (`apps.connections.open`) and return the short-lived `wss://` URL, with the app-level token. |

### The writes

All four go through the consent registrar and are declared `recoverable: true`. Outside the gateway
each is gated by owner consent, a write-scope allow-list, a mutation budget and an audit record; in
the gateway the executor is the gate. Scope them with `NIMBUS_MCP_SLACK_WRITE_SCOPE`, a
comma-separated list of `kind:value` terms with exact matching. Three kinds exist:

- `channel:<channel id>` covers `slack_message_post` and `slack_chat_post`.
- `user:<user id>` covers `slack_message_post_dm`, matched against the `user_ids` argument as given
  (a DM has no channel until `conversations.open` creates one).
- `view:modal` covers `slack_views_open`, whose target is always that fixed value.

An unset or empty scope refuses every write, and an unknown kind fails at startup.

## ChatOps typed confirmation

Nimbus ChatOps can post a Block Kit card (`slack_chat_post` with `blocks`: 1 to 50 objects, each with a string `type`, at most 16 KiB serialised) and, when a user clicks one of its buttons, open a confirmation modal with `slack_views_open` (`trigger_id` plus a `view` of type `modal`, at most 16 KiB serialised). Both use the bot token (`SLACK_BOT_TOKEN`). Typed confirmation needs:

- Interactivity enabled for the Socket Mode app (`settings.interactivity.is_enabled: true` in the app manifest), so button clicks reach Nimbus.
- The `views:write` bot scope (`oauth_config.scopes.bot`), so the bot can open the modal.

## See also

- [Nimbus Connectors Overview](https://nimbus-agent.dev/user-guide/connectors/)
- [Nimbus Architecture Overview](https://nimbus-agent.dev/architecture-overview/)
- [HITL and Safety](https://nimbus-agent.dev/user-guide/hitl-and-safety/)

## License

AGPL-3.0
