# Google Calendar Connector

## What this is

First-party Nimbus MCP connector for [Google Calendar](https://calendar.google.com/), over the
Google Calendar API v3 (`https://www.googleapis.com/calendar/v3`). It exposes three **read-only**
tools; there are no write tools and `hitlRequired` is empty.

Google Calendar rides on the existing `google` OAuth provider (alongside Google Drive, Gmail,
Google Meet and Google Photos). The read scope is `calendar.readonly`.

## Install

Bundled with Nimbus — no separate install required.

## Credentials

The Gateway manages the Google OAuth flow and injects a short-lived access token as
`GOOGLE_OAUTH_ACCESS_TOKEN` at spawn time; the connector never touches the vault. Run standalone,
set that variable yourself. The token is sent as `Authorization: Bearer <token>` to
`www.googleapis.com` only and is never logged. A missing token fails the call by name before any
request is made.

## Tools

| Tool | Purpose |
| --- | --- |
| `gcal_calendar_list` | List the calendars the user can see (`GET /users/me/calendarList`). `maxResults` 1-250 (default 100), optional `pageToken`. |
| `gcal_event_list` | List events of one calendar in a window (`GET /calendars/{calendarId}/events`). `calendarId` (default `primary`), `timeMin` and `timeMax` (RFC 3339 with an offset or `Z`, `timeMax` after `timeMin`), `maxResults` 1-250 (default 50), optional `pageToken`. Recurring events are expanded (`singleEvents=true`) and ordered by start. |
| `gcal_event_get` | Get one event (`GET /calendars/{calendarId}/events/{eventId}`). `calendarId` defaults to `primary`. |

Every path value is URL-encoded, a `.` or `..` id is refused, and each call makes exactly one
request: the connector never follows `nextPageToken` itself. A caller that wants the next page
passes the token back.

## See also

- [Nimbus Connectors Overview](https://nimbus-agent.dev/user-guide/connectors/)
- [HITL and Safety](https://nimbus-agent.dev/user-guide/hitl-and-safety/)

## License

AGPL-3.0
