# Gmail Connector

## What this is

First-party Nimbus MCP connector for Gmail. It gives the Nimbus agent read access to messages,
threads and labels through the Gmail REST API, and four guarded writes: create a draft, send a
draft, send a message, and archive a thread.

## Install

Bundled with Nimbus — no separate install required.

## Quickstart

```bash
nimbus connector auth gmail
nimbus ask "Summarize my recent activity in Gmail"
```

The gateway injects the credential as environment variables at spawn time; the connector itself
never touches the vault.

| Variable | Required | Purpose |
| --- | --- | --- |
| `GOOGLE_OAUTH_ACCESS_TOKEN` | yes | The Google OAuth access token, sent as a Bearer token. Read on every call. |
| `GOOGLE_OAUTH_SCOPES` | no | Space-separated scope URIs the token holds. It gates `gmail_thread_archive` only; an unset or blank value hides that tool. |

Requests go to `https://gmail.googleapis.com/gmail/v1/users/me`, through the same-origin check of
`resolveUrlWithBase`.

Tools exposed:

| Tool | Purpose |
| --- | --- |
| `gmail_message_list` | List message ids: `maxResults` 1-100 (default 25), `pageToken`, a Gmail search query `q` of at most 500 characters, `labelIds`, `includeSpamTrash`. |
| `gmail_message_read` | Read one message by `messageId`; `format` is `minimal`, `metadata` (default, with the Subject, From, To and Date headers), `full` or `raw`. |
| `gmail_thread_read` | Read one thread and its messages by `threadId`; `format` is `minimal`, `metadata` (default) or `full`. |
| `gmail_label_list` | List all labels. |
| `gmail_draft_create` (write) | Create a draft: `to`, `subject` (up to 998 characters), `body` (up to 1,000,000), optional `cc` and `bcc`. Sent as a plain-text UTF-8 message. |
| `gmail_draft_send` (write) | Send an existing draft by `draftId`. |
| `gmail_message_send` (write) | Send a new message (not a draft); same arguments as `gmail_draft_create`. |
| `gmail_thread_archive` (write) | Archive a thread: remove the `INBOX` label from `threadId` (letters and digits only, at most 64 characters). |

### The writes

All four register through `createWriteToolRegistrar`. Standalone, that adds the consent prompt, the
write scope, the mutation budget and the audit record; inside the gateway the executor's approval
is the gate. The standalone scope variable is `NIMBUS_MCP_GMAIL_WRITE_SCOPE`, with kinds
`recipient`, `draft` and `thread`. A term is `kind:value` and matches exactly, with no prefix
matching.

- `gmail_draft_create` is registered as recoverable: the draft sits in Drafts and nothing is sent.
  Scope: one `recipient:<address>` term per address in `to`, `cc` and `bcc`;
  every address must be in scope (a display name is dropped, the address inside `<>` is checked).
- `gmail_draft_send` sends a draft, which cannot be recalled, so it is registered as not
  recoverable; the `draftId` is recorded first. Scope: `draft:<draftId>`.
- `gmail_message_send` is registered as not recoverable; the recipient and subject are recorded
  first. Scope: one `recipient:<address>` term per address in `to`, `cc` and `bcc`;
  every address must be in scope (a display name is dropped, the address inside `<>` is checked).
- `gmail_thread_archive` removes the `INBOX` label from every message of the thread. Nothing is
  deleted, and every other label stays. It is registered as recoverable. Scope: `thread:<threadId>`.
  It is registered only when the token holds `https://www.googleapis.com/auth/gmail.modify` (or the
  full-mailbox `https://mail.google.com/`), as the gateway reports in `GOOGLE_OAUTH_SCOPES`. An
  unset `GOOGLE_OAUTH_SCOPES` hides it, so a gateway that does not pass scopes never lists it. A
  connection authorised with only the default read and compose scopes needs a fresh
  `nimbus connector auth gmail` before the tool appears.

## See also

- [Nimbus Connectors Overview](https://nimbus-agent.dev/user-guide/connectors/)
- [Nimbus Architecture Overview](https://nimbus-agent.dev/architecture-overview/)
- [HITL and Safety](https://nimbus-agent.dev/user-guide/hitl-and-safety/)

## License

AGPL-3.0
