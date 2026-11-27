# Google Calendar Connector

## What this is

First-party Nimbus MCP connector for [Google Calendar](https://calendar.google.com/), over the
Google Calendar API v3 (`https://www.googleapis.com/calendar/v3`). It exposes three read tools and,
for a token that may write, three event write tools: create, update and delete.

Google Calendar rides on the existing `google` OAuth provider (alongside Google Drive, Gmail,
Google Meet and Google Photos).

## Install

Bundled with Nimbus — no separate install required.

## Credentials

The Gateway manages the Google OAuth flow and injects a short-lived access token as
`GOOGLE_OAUTH_ACCESS_TOKEN` at spawn time; the connector never touches the vault. Run standalone,
set that variable yourself. The token is sent as `Authorization: Bearer <token>` to
`www.googleapis.com` only and is never logged. A missing token fails the call by name before any
request is made.

**Scopes.** The reads work with `https://www.googleapis.com/auth/calendar.readonly`. The writes need
the full calendar scope, `https://www.googleapis.com/auth/calendar` (`calendar.events` is accepted
too, since Google allows event writes under it). The connector does not request scopes itself: it
reads the scopes the token holds from `GOOGLE_OAUTH_SCOPES` (space-separated, the full scope URIs
Google returns) and registers the three write tools only when one of those two is among them. An
unset or blank `GOOGLE_OAUTH_SCOPES` hides the writes, so a gateway that does not pass scopes, or a
connection authorised read-only, never lists a write its token cannot perform. Standalone, set
`GOOGLE_OAUTH_SCOPES` to the scopes your token was granted.

## Tools

| Tool | Purpose |
| --- | --- |
| `gcal_calendar_list` | List the calendars the user can see (`GET /users/me/calendarList`). `maxResults` 1-250 (default 100), optional `pageToken`. |
| `gcal_event_list` | List events of one calendar in a window (`GET /calendars/{calendarId}/events`). `calendarId` (default `primary`), `timeMin` and `timeMax` (RFC 3339 with an offset or `Z`, `timeMax` after `timeMin`), `maxResults` 1-250 (default 50), optional `pageToken`. Recurring events are expanded (`singleEvents=true`) and ordered by start. |
| `gcal_event_get` | Get one event (`GET /calendars/{calendarId}/events/{eventId}`). `calendarId` defaults to `primary`. |
| `gcal_event_create` | Write. Create an event (`POST /calendars/{calendarId}/events`). `summary` (1-1024 characters), `start` and `end`, optional `description` (up to 8192), `location` (up to 1024), `attendees`, `recurrence`, `sendUpdates`. |
| `gcal_event_update` | Write. Change an event (`PATCH /calendars/{calendarId}/events/{eventId}`): only the fields given are sent, and at least one of `summary`, `description`, `location`, `start` and `end`, `attendees`, `recurrence` is required. |
| `gcal_event_delete` | Write. Delete an event (`DELETE /calendars/{calendarId}/events/{eventId}`). Answers `{ deleted: true }`, or `{ deleted: false, alreadyDeleted: true }` when Google answers 410 Gone. |

Every path value is URL-encoded, a `.` or `..` id is refused, and each call makes exactly one
request (a standalone update or delete first reads the event, below): the connector never follows
`nextPageToken` itself. A caller that wants the next page passes the token back.

### Write arguments

- **Times.** `start` and `end` are both `{ dateTime, timeZone? }` for a timed event, where
  `dateTime` is RFC 3339 with an offset or `Z` and `timeZone` an IANA name such as `Europe/Berlin`,
  or both `{ date: "YYYY-MM-DD" }` for an all-day event. A mix of the two is refused, as is an end
  that is not after the start. Google's all-day end date is exclusive: a one-day event on
  `2026-12-01` has `end: { date: "2026-12-02" }`. `gcal_event_update` takes `start` and `end`
  together or not at all, and clears the other kind of time explicitly (`dateTime: null` when it
  sends a `date`, and the reverse), so an event can move between timed and all-day.
- **Attendees** are guest emails, at most 100, sent as `[{ email }]`. A repeated email (ignoring
  case) is refused rather than merged. On update the list **replaces** the whole guest list: anyone
  not named is removed, and `[]` removes every guest.
- **Recurrence** is up to 10 RFC 5545 lines, each `RRULE:`, `EXRULE:`, `RDATE` or `EXDATE`.
  `RDATE` and `EXDATE` may carry `TZID=` and `VALUE=DATE|DATE-TIME|PERIOD` parameters
  (`EXDATE;TZID=Europe/Berlin:20261215T090000`). Any other property or parameter, a line break or
  another control character is refused. A recurring timed event needs `timeZone` on both ends, since Google expands
  the recurrence in that zone.
- **Recurring events.** Update and delete act on exactly the `eventId` given: a series id changes or
  deletes every occurrence, and an instance id (as `gcal_event_list` returns, since it expands
  recurring events) changes or deletes that one occurrence.
- **`sendUpdates`** is the notification policy Google is asked to follow, on all three writes:
  `none` (the default) asks for no notifications, though Google's reference says some emails may
  still be sent and that guests on other calendar systems may then not see the change;
  `externalOnly` notifies only guests who do not use Google Calendar; and `all` notifies every
  guest. It is always sent as a query parameter, so Google's own default never
  applies.
- No Meet link is added: `conferenceData` is never sent, and neither is `conferenceDataVersion`.

### Safety

Every write needs the gateway's HITL approval. Standalone, it needs the consent kit's prompt and a
term in `NIMBUS_MCP_GOOGLE_CALENDAR_WRITE_SCOPE`, kind `calendar`: `calendar:primary` (the default
calendar, when `calendarId` is left out) or `calendar:<calendarId>`, e.g.
`calendar:team@group.calendar.google.com`. An argument the tool is certain to refuse (an inverted
range, an update with nothing to change) is refused before the prompt. Before an update or a delete
the connector reads the event and records its fields in the audit log, since the API has no undo.

Every request refuses a redirect on a write, and follows one on a read only to the same origin, so
the token never reaches another host. An error quotes Google's status and at most 300 characters
of its body, never the token.

## See also

- [Nimbus Connectors Overview](https://nimbus-agent.dev/user-guide/connectors/)
- [HITL and Safety](https://nimbus-agent.dev/user-guide/hitl-and-safety/)

## License

AGPL-3.0
