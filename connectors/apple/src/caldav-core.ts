/**
 * CalDAV client interface + pure calendar selection/normalization helpers
 * for the iCloud Calendar connector.
 *
 * Design: the CalDavClient interface is the injectable seam — the real (network)
 * implementation lives in server.ts (coverage-excluded). Pure helpers are
 * separately tested here.
 */

import type { ParsedEvent } from "@nimbus-dev/sdk";

// ---------------------------------------------------------------------------
// CalendarRef — a discovered calendar
// ---------------------------------------------------------------------------

export interface CalendarRef {
  readonly url: string;
  readonly displayName: string;
}

// ---------------------------------------------------------------------------
// EventWindow — a UTC time range for fetching events
// ---------------------------------------------------------------------------

export interface EventWindow {
  readonly startUtc: string;
  readonly endUtc: string;
}

// ---------------------------------------------------------------------------
// CalDavClient — injectable transport interface
// ---------------------------------------------------------------------------

export interface CalDavClient {
  listCalendars(): Promise<CalendarRef[]>;
  /**
   * The calendars the last discovery found, with no request: what a scope check reads, since it
   * runs synchronously BEFORE the consent prompt. Empty until `listCalendars` has run once.
   */
  knownCalendars(): readonly CalendarRef[];
  listEvents(
    cal: CalendarRef,
    window: EventWindow,
  ): Promise<{ href: string; event: ParsedEvent }[]>;
  putEvent(cal: CalendarRef, uid: string, ics: string): Promise<{ href: string }>;
  /**
   * One event by its object URL, with the entity tag the server holds for it (RFC 4791 5.3.4: a GET on
   * a calendar object resource MUST return an ETag). `href` must lie under one of the account's own
   * calendars; any other is refused BEFORE a request is made.
   */
  getEvent(href: string): Promise<{ calendar: string; etag: string | null; event: ParsedEvent }>;
  /** Delete by object URL; `href` must lie under one of the account's own calendars. */
  deleteEvent(href: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// calendarOwningHref — which calendar an event href lies under
// ---------------------------------------------------------------------------

/**
 * The calendar whose collection URL contains `href`, or undefined. Both are compared as normalised
 * absolute URLs (dot segments resolved), the calendar's with a trailing slash, so `.../home/` does
 * not own `.../home-evil/x.ics` or `.../home/../other/x.ics`, and another host owns nothing.
 */
export function calendarOwningHref<C extends { readonly url: string }>(
  calendars: Iterable<C>,
  href: string,
): C | undefined {
  let target: string;
  try {
    target = new URL(href).toString();
  } catch {
    return undefined;
  }
  for (const cal of calendars) {
    let base: string;
    try {
      base = new URL(cal.url).toString();
    } catch {
      continue;
    }
    if (!base.endsWith("/")) base = `${base}/`;
    if (target.startsWith(base) && target.length > base.length) return cal;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// selectCalendars — pure calendar filter helper
// ---------------------------------------------------------------------------

/**
 * Filter the full list of calendars by include/exclude display-name lists.
 *
 * Rules (in priority order):
 * 1. If `include` is non-empty, return only calendars whose `displayName`
 *    appears in the include list (exact match).
 * 2. Else if `exclude` is non-empty, return all calendars whose `displayName`
 *    does NOT appear in the exclude list.
 * 3. Both empty (or both absent) → return all calendars.
 */
export function selectCalendars(
  all: CalendarRef[],
  cfg: { include?: readonly string[] | undefined; exclude?: readonly string[] | undefined },
): CalendarRef[] {
  const include = cfg.include ?? [];
  const exclude = cfg.exclude ?? [];

  if (include.length > 0) {
    const includeSet = new Set(include);
    return all.filter((c) => includeSet.has(c.displayName));
  }

  if (exclude.length > 0) {
    const excludeSet = new Set(exclude);
    return all.filter((c) => !excludeSet.has(c.displayName));
  }

  return all;
}

// ---------------------------------------------------------------------------
// clampInstances — cap the number of events returned per calendar
// ---------------------------------------------------------------------------

/**
 * Return the first `max` elements from `rows`. When `rows.length <= max`,
 * returns the original array reference unchanged (zero allocation).
 */
export function clampInstances<T>(rows: readonly T[], max: number): T[] {
  // A non-positive cap (e.g. when an earlier calendar already filled the budget)
  // means "take nothing" — `slice(0, -n)` would otherwise drop from the end.
  if (max <= 0) {
    return [];
  }
  if (rows.length <= max) {
    return rows as T[];
  }
  return rows.slice(0, max);
}

// ---------------------------------------------------------------------------
// caldavObjectFilename — derive a URL-path-safe .ics filename from a UID
// ---------------------------------------------------------------------------

/**
 * Build a CalDAV object filename (`<safe-uid>.ics`) from an event UID.
 *
 * The UID is embedded verbatim into the CalDAV object URL path segment, so any
 * character that is unsafe in a path segment — `/`, `\`, `?`, `#`, `%`, `:`,
 * whitespace, control chars — must be stripped to avoid a malformed/ambiguous
 * URL (e.g. a summary-derived UID containing `/` would split the path) or path
 * traversal (`../`). Allowed: URL-unreserved chars plus `@` (RFC 3986 §2.3 +
 * the common `uid@host` form). A UID that sanitizes to empty falls back to
 * `event` so a usable filename is always produced.
 */
export function caldavObjectFilename(uid: string): string {
  const safe = uid.replace(/[^A-Za-z0-9\-_.~@]/g, "");
  return `${safe === "" ? "event" : safe}.ics`;
}
