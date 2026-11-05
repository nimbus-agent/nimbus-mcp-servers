# Outlook Connector

## What this is

Nimbus MCP connector for Outlook. Indexes and provides context from Outlook to the Nimbus agent.

## Install

Bundled with Nimbus — no separate install required.

## Quickstart

```bash
nimbus connector auth outlook
nimbus ask "Summarize my recent activity in Outlook"
```

## Drafts

`outlook_draft_create` saves a message in Drafts through Microsoft Graph and sends nothing; it needs
the `Mail.ReadWrite` scope. Standalone, its write scope (`recipient:<address>` in
`NIMBUS_MCP_OUTLOOK_WRITE_SCOPE`) matches the `to` field only. Addresses in `cc` and `bcc` are not
scope-checked, which is acceptable because a draft is never sent by the tool, but review a draft
before you send it.

## See also

- [Outlook Connector Documentation](https://nimbus-agent.dev/user-guide/connectors/)
- [Nimbus Architecture Overview](https://nimbus-agent.dev/architecture-overview/)
- [HITL and Safety](https://nimbus-agent.dev/user-guide/hitl-and-safety/)

## License

AGPL-3.0
