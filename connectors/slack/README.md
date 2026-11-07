# Slack Connector

## What this is

Nimbus MCP connector for Slack. Indexes and provides context from Slack to the Nimbus agent.

## Install

Bundled with Nimbus — no separate install required.

## Quickstart

```bash
nimbus connector auth slack
nimbus ask "Summarize my recent activity in Slack"
```

## ChatOps typed confirmation

Nimbus ChatOps can post a Block Kit card (`slack_chat_post` with `blocks`: 1 to 50 objects, each with a string `type`, at most 16 KiB serialised) and, when a user clicks one of its buttons, open a confirmation modal with `slack_views_open` (`trigger_id` plus a `view` of type `modal`, at most 16 KiB serialised). Both use the bot token (`SLACK_BOT_TOKEN`). Typed confirmation needs:

- Interactivity enabled for the Socket Mode app (`settings.interactivity.is_enabled: true` in the app manifest), so button clicks reach Nimbus.
- The `views:write` bot scope (`oauth_config.scopes.bot`), so the bot can open the modal.

## See also

- [Slack Connector Documentation](https://nimbus-agent.dev/user-guide/connectors/)
- [Nimbus Architecture Overview](https://nimbus-agent.dev/architecture-overview/)
- [HITL and Safety](https://nimbus-agent.dev/user-guide/hitl-and-safety/)

## License

AGPL-3.0
