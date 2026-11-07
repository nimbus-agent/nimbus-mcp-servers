# Teams Connector

## What this is

Nimbus MCP connector for Teams. Indexes and provides context from Teams to the Nimbus agent.

## Install

Bundled with Nimbus — no separate install required.

## Quickstart

```bash
nimbus connector auth teams
nimbus ask "Summarize my recent activity in Teams"
```

## ChatOps adaptive cards

`teams_chat_post` (the bot reply surface) takes an optional `attachments` array of exactly one `{ contentType: "application/vnd.microsoft.card.adaptive", content: <card object> }`, at most 28 KiB serialised. It is sent in the Bot Framework activity unchanged; when absent the activity is plain text as before.

## See also

- [Teams Connector Documentation](https://nimbus-agent.dev/user-guide/connectors/)
- [Nimbus Architecture Overview](https://nimbus-agent.dev/architecture-overview/)
- [HITL and Safety](https://nimbus-agent.dev/user-guide/hitl-and-safety/)

## License

AGPL-3.0
