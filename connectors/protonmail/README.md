# ProtonMail (Bridge) Connector

## What this is

Nimbus MCP connector for **ProtonMail** via the **ProtonMail Bridge** app (the
Tier-4 EMAIL connector class). ProtonMail is end-to-end encrypted, so its servers
cannot be read directly; the local Bridge app decrypts mail on your machine and
exposes a standard IMAP/SMTP interface on the loopback interface. This connector
indexes your mailbox over that local IMAP listener as `protonmail:email` items
and can send mail over the Bridge SMTP relay behind a Human-in-the-Loop (HITL)
consent gate.

By design this connector indexes **headers + a short plain-text body preview +
attachment metadata only**:

- **Headers** — subject, from, to/cc, date, message-id (from the IMAP `ENVELOPE`).
- **Body preview** — a single capped (~2 KB / 2000 chars) plain-text excerpt.
- **Attachment metadata** — filename, size, and mimetype (from `BODYSTRUCTURE`).

It **never** downloads or parses attachment bytes and never fetches the full
message body.

## Install

Bundled with Nimbus — no separate install required. Requires the
[ProtonMail Bridge](https://proton.me/mail/bridge) desktop app to be installed
and running. Uses `imapflow` (IMAP read) and `nodemailer` (SMTP send) against the
Bridge's loopback listeners.

## Quickstart

In ProtonMail Bridge, copy the Bridge-generated IMAP/SMTP username and password
(Bridge → your account → Mailbox details). Configure the connector, then query
or send. `nimbus connector auth protonmail` does not work for this connector — set the Vault keys directly. `protonmail.username` and
`protonmail.password` are required; host/port keys default to the Bridge loopback
listeners, and the SMTP username/password are only needed for `protonmail_mail_send`.

```bash
nimbus vault set protonmail.username <bridge-username>
nimbus vault set protonmail.password <bridge-password>
# Optional (defaults shown):
# nimbus vault set protonmail.imap_host 127.0.0.1
# nimbus vault set protonmail.imap_port 1143
# nimbus vault set protonmail.mailbox INBOX
# nimbus vault set protonmail.smtp_host 127.0.0.1
# nimbus vault set protonmail.smtp_port 1025
# nimbus vault set protonmail.smtp_username <bridge-username>
# nimbus vault set protonmail.smtp_password <bridge-password>
nimbus ask "Summarize my unread ProtonMail from this week"
```

Bridge listens on `127.0.0.1` (IMAP 1143 / SMTP 1025 by default) with a
self-signed certificate; the connection uses STARTTLS without certificate
verification because it never leaves the loopback interface. These local
host:port entries are added to the sandbox network allow-list at spawn time.

## Tools

- `protonmail_list` — list recent messages (headers + attachment metadata + preview).
- `protonmail_get` — fetch one message by uid (headers + attachment metadata + preview).
- `protonmail_search` — substring search over subject/from/to (headers only).
- `protonmail_mail_send` — send a new message over the Bridge SMTP relay. Requires
  Gateway HITL `email.send`.

### The writes

`protonmail_mail_send` is the only write. It goes through the consent registrar (via the shared
mail-send declaration), so outside the gateway it is gated by owner consent, a write-scope
allow-list, a mutation budget and an audit record; in the gateway the executor is the gate.

- **Changes:** sends a new message over the Bridge SMTP relay.
- **Recoverable:** `false`. A sent mail cannot be recalled and nothing remains to query, so
  `capturePreState` records `{to, subject}` first.
- **Scope:** `NIMBUS_MCP_PROTONMAIL_WRITE_SCOPE`, a comma-separated list of `kind:value` terms with
  exact matching. One kind exists, `recipient`: one `recipient:<address>` term per address; every
  address in `to`, `cc` and `bcc` must be in scope (a display name is dropped; the address inside
  `<>` is what is checked; an entry that is not exactly one simple address is checked as written).
  An unset or empty scope refuses every write, and an unknown kind fails at startup.

## See also

- [Email Connector Documentation](https://nimbus-agent.dev/user-guide/connectors/)
- [Nimbus Architecture Overview](https://nimbus-agent.dev/architecture-overview/)
- [HITL and Safety](https://nimbus-agent.dev/user-guide/hitl-and-safety/)

## License

AGPL-3.0
