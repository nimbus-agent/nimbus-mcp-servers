# Gmail Connector

## What this is

Nimbus MCP connector for Gmail. Indexes and provides context from Gmail to the Nimbus agent.

## Install

Bundled with Nimbus — no separate install required.

## Quickstart

```bash
nimbus connector auth gmail
nimbus ask "Summarize my recent activity in Gmail"
```

## Writes

Every write needs the gateway's HITL approval (standalone: the consent kit's prompt and
`NIMBUS_MCP_GMAIL_WRITE_SCOPE`, kinds `recipient`, `draft` and `thread`).

- `gmail_draft_create`, `gmail_draft_send`, `gmail_message_send`.
- `gmail_thread_archive({ threadId })` removes the `INBOX` label from every message of the thread.
  Nothing is deleted, and every other label stays. It is registered only when the token holds
  `https://www.googleapis.com/auth/gmail.modify` (or the full-mailbox `https://mail.google.com/`), as
  the gateway reports in `GOOGLE_OAUTH_SCOPES`. An unset `GOOGLE_OAUTH_SCOPES` hides it, so a gateway
  that does not pass scopes never lists it. A connection authorised with only the default read and
  compose scopes needs a fresh `nimbus connector auth gmail` before the tool appears.

## See also

- [Gmail Connector Documentation](https://nimbus-agent.dev/user-guide/connectors/)
- [Nimbus Architecture Overview](https://nimbus-agent.dev/architecture-overview/)
- [HITL and Safety](https://nimbus-agent.dev/user-guide/hitl-and-safety/)

## License

AGPL-3.0
