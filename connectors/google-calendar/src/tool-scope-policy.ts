/**
 * Whether the token the gateway passes may write to Google Calendar. The gateway sets
 * `GOOGLE_OAUTH_SCOPES` (space-separated, the full scope URIs Google returns) at spawn.
 *
 * The connector's original grant is `calendar.readonly`, so the write tools are registered only
 * for a token that holds a write scope: a read-only token never lists a write it cannot perform.
 * An ABSENT env does NOT register them (fail closed, as Gmail's policy does): a gateway that does
 * not pass scopes is a gateway whose token is not known to write.
 */
const CALENDAR_FULL = "https://www.googleapis.com/auth/calendar";
/** Events-only write scope; Google accepts it for events.insert, events.patch and events.delete. */
const CALENDAR_EVENTS = "https://www.googleapis.com/auth/calendar.events";

const WRITE_SCOPES: ReadonlySet<string> = new Set([CALENDAR_FULL, CALENDAR_EVENTS]);

/** The scopes in `GOOGLE_OAUTH_SCOPES`, or `undefined` when it is unset or blank. */
export function parseGoogleOAuthScopesFromEnv(): string[] | undefined {
  const raw = process.env["GOOGLE_OAUTH_SCOPES"];
  if (raw === undefined) return undefined;
  const parts = raw.split(/\s+/).filter((s) => s.length > 0);
  return parts.length === 0 ? undefined : parts;
}

/** Whether the event write tools register for a token holding `granted` (`undefined`: unknown). */
export function calendarWritesAllowed(granted: string[] | undefined): boolean {
  if (granted === undefined) return false;
  return granted.some((scope) => WRITE_SCOPES.has(scope));
}
