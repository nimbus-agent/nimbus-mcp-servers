# IMAP / SMTP Email Connector

## What this is

Nimbus MCP connector for generic **IMAP/SMTP** email (the Tier-4 EMAIL connector
class). It indexes the user's mailbox over raw IMAP as `imap:email` items and can
send mail over SMTP behind a Human-in-the-Loop (HITL) consent gate.

By design this connector indexes **headers + a short plain-text body preview +
attachment metadata only**:

- **Headers** — subject, from, to/cc, date, message-id (from the IMAP `ENVELOPE`).
- **Body preview** — a single capped (~2 KB / 2000 chars) plain-text excerpt.
- **Attachment metadata** — filename, size, and mimetype (from `BODYSTRUCTURE`).

It **never** downloads or parses attachment bytes and never fetches the full
message body. There is no surface to request `BODY[]` or an attachment part.

## Install

Bundled with Nimbus — no separate install required. Uses `imapflow` (IMAP read
of headers / `BODYSTRUCTURE` / a truncated text part) and `nodemailer` (SMTP send).

## Quickstart

IMAP/SMTP credentials are per-tenant (your mail host, port, username, password).
Configure the connector, then query or send. `nimbus connector auth imap` does not work for this connector — set the Vault keys directly.
`imap.host`, `imap.username` and `imap.password` are required; the rest are
optional (`imap.port` defaults to 993, `imap.smtp_port` to 465, and the SMTP keys
are only needed for `imap_mail_send`).

```bash
nimbus vault set imap.host imap.example.com
nimbus vault set imap.username <your-username>
nimbus vault set imap.password <your-password>
# Optional:
# nimbus vault set imap.port 993
# nimbus vault set imap.mailbox INBOX
# nimbus vault set imap.smtp_host smtp.example.com
# nimbus vault set imap.smtp_port 465
# nimbus vault set imap.smtp_username <your-smtp-username>
# nimbus vault set imap.smtp_password <your-smtp-password>
nimbus ask "Summarize my unread email from this week"
```

The IMAP host is contacted on its IMAP port (typically 993) and the SMTP host on
its submission port (typically 465 or 587). These non-443 host:port entries are
added to the sandbox network allow-list at spawn time.

## Tools

- `imap_list` — list recent messages (headers + attachment metadata + preview).
- `imap_get` — fetch one message by uid (headers + attachment metadata + preview).
- `imap_search` — substring search over subject/from/to (headers only).
- `imap_mail_send` — send a new message over SMTP. Requires Gateway HITL
  `email.send`.

## See also

- [Email Connector Documentation](https://nimbus-agent.dev/user-guide/connectors/)
- [Nimbus Architecture Overview](https://nimbus-agent.dev/architecture-overview/)
- [HITL and Safety](https://nimbus-agent.dev/user-guide/hitl-and-safety/)

## License

AGPL-3.0
