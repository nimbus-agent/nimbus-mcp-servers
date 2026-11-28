# Outlook Connector

## What this is

First-party Nimbus MCP connector for Outlook through Microsoft Graph. It gives the Nimbus agent
read access to mail folders, messages, calendar events and contacts, and four guarded writes: send
a mail, save a draft, create a calendar event and delete one.

## Install

Bundled with Nimbus — no separate install required.

## Quickstart

```bash
nimbus connector auth outlook
nimbus ask "Summarize my recent activity in Outlook"
```

The gateway injects the credential as environment variables at spawn time; the connector itself
never touches the vault.

| Variable | Required | Purpose |
| --- | --- | --- |
| `MICROSOFT_OAUTH_ACCESS_TOKEN` | yes | The Microsoft Graph OAuth access token, sent as a Bearer token. Read on every call. |
| `MICROSOFT_OAUTH_SCOPES` | no | Space-separated scopes the token holds. When set and non-blank, a tool registers only if the scopes cover it (table below); when unset or blank, every tool registers. |

Requests go to `https://graph.microsoft.com/v1.0`. A `nextLink` argument is resolved through
`resolveUrlWithBase`, which refuses any origin other than Graph's before the token is sent.

Tools exposed:

| Tool | Purpose |
| --- | --- |
| `outlook_mail_folders` | List mail folders: `top` 1-200 (default 50), or a `nextLink` to continue. |
| `outlook_mail_list` | List messages of `folderId` (default `inbox`): `top` 1-100 (default 25), `skip`, an OData `filter` of at most 500 characters, or a `nextLink`. Returns id, subject, body preview, received and modified times, `hasAttachments` and `webLink`. |
| `outlook_mail_read` | Read one message by `messageId`, with its attachments expanded (`$expand=attachments`). |
| `outlook_mail_send` (write) | Send a mail: `to` (up to 2000 characters), `subject` (up to 500), `body` (up to 1,000,000), `contentType` `text` (default) or `html`, optional `cc`. The sent copy is saved to Sent Items. |
| `outlook_draft_create` (write) | Save a mail as a draft in Drafts; it is not sent. Same arguments as `outlook_mail_send` plus `bcc`. Returns the draft's `id` and `webLink`. |
| `outlook_calendar_list` | List events in the window `startDateTime` to `endDateTime` (`/me/calendarView`): `top` 1-200 (default 50), or a `nextLink`. |
| `outlook_calendar_get` | Get one event by `eventId`. |
| `outlook_calendar_create` (write) | Create an event: `subject` (up to 500), `startDateTime`, `endDateTime`, `timeZone` (default `UTC`), plain-text `body` (up to 50,000), comma-separated `attendees` (up to 4000, each added as required). |
| `outlook_calendar_delete` (write) | Delete the event `eventId`. |
| `outlook_contact_list` | List contacts of the default folder: `top` 1-200 (default 50), `skip`, or a `nextLink`. |
| `outlook_contact_get` | Get one contact by `contactId`. |

### Scope gating

With `MICROSOFT_OAUTH_SCOPES` set, a tool is registered only when its minimum scope is held
(`Mail.ReadWrite` also satisfies `Mail.Read`, and `Calendars.ReadWrite` satisfies `Calendars.Read`):

| Scope | Tools |
| --- | --- |
| `Mail.Read` | `outlook_mail_folders`, `outlook_mail_list`, `outlook_mail_read` |
| `Mail.Send` | `outlook_mail_send` |
| `Mail.ReadWrite` | `outlook_draft_create` |
| `Calendars.Read` | `outlook_calendar_list`, `outlook_calendar_get` |
| `Calendars.ReadWrite` | `outlook_calendar_create`, `outlook_calendar_delete` |
| `Contacts.Read` | `outlook_contact_list`, `outlook_contact_get` |

### The writes

All four register through `createWriteToolRegistrar`. Standalone, that adds the consent prompt, the
write scope, the mutation budget and the audit record; inside the gateway the executor's approval
is the gate. The standalone scope variable is `NIMBUS_MCP_OUTLOOK_WRITE_SCOPE`, with kinds
`recipient` and `calendar`. A term is `kind:value` and matches exactly, with no prefix matching.

- `outlook_mail_send` sends a mail that cannot be recalled, so it is registered as not recoverable;
  the recipient and subject are recorded first. Scope: one `recipient:<address>` term per address
  in `to` and `cc`; every address must be in scope (a display name is dropped, the address inside
  `<>` is checked).
- `outlook_draft_create` writes only to Drafts and sends nothing, so it is registered as
  recoverable. Scope: one `recipient:<address>` term per address in `to`, `cc` and `bcc`;
  every address must be in scope (a display name is dropped, the address inside `<>` is checked).
- `outlook_calendar_create` is registered as recoverable. Scope: `calendar:<subject>`, matched
  against the event's subject.
- `outlook_calendar_delete` is registered as not recoverable; the `eventId` is recorded first.
  Scope: `calendar:<eventId>`.

## See also

- [Nimbus Connectors Overview](https://nimbus-agent.dev/user-guide/connectors/)
- [Nimbus Architecture Overview](https://nimbus-agent.dev/architecture-overview/)
- [HITL and Safety](https://nimbus-agent.dev/user-guide/hitl-and-safety/)

## License

AGPL-3.0
