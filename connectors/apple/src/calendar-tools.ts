import {
  type ConsentServer,
  createWriteToolRegistrar,
  type WriteToolRegistrar,
} from "../../../shared/consent-kit.ts";
/**
 * Apple Calendar tool handlers (read + write) over an injected CalDavClient.
 *
 * All three tools are registered here and wired into registerAppleTools in Task C3.
 * The real CalDavClient (tsdav) lives in server.ts (coverage-excluded); this module
 * depends only on the injectable interface, making it fully unit-testable.
 */

import { buildVEvent } from "@nimbus-dev/sdk";
import { z } from "zod";
import { createRegisterSimpleTool, mcpJsonResult } from "../../../shared/mcp-tool-kit.ts";
import { capPreview } from "./apple-mail-core.ts";
import {
  type CalDavClient,
  type CalendarRef,
  clampInstances,
  selectCalendars,
} from "./caldav-core.ts";

// ---------------------------------------------------------------------------
// Config shape (calendar subsection)
// ---------------------------------------------------------------------------

export interface CalendarToolConfig {
  readonly include?: readonly string[];
  readonly exclude?: readonly string[];
  /** Maximum events returned across all calendars (default: 200). */
  readonly maxInstances?: number;
}

// ---------------------------------------------------------------------------
// Zod arg schemas
// ---------------------------------------------------------------------------

const listArgs = z.object({
  startUtc: z.string().min(1),
  endUtc: z.string().min(1),
  calendar: z.string().min(1).optional(),
});

/** A C0 control (CR, LF and TAB included), DEL, or a C1 control. */
function isControlCode(code: number): boolean {
  return code <= 0x1f || (code >= 0x7f && code <= 0x9f);
}

/**
 * Whether `value` carries a control character anywhere. Event text reaches iCalendar content
 * lines, where CR or LF ends a line and starts a new property; the SDK's escaping turns CRLF or LF
 * into an escaped newline but leaves a bare CR. So the input is REFUSED here rather than relying
 * on (or adding) an escape. Nothing is stripped.
 */
export function hasControlCharacter(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    if (isControlCode(value.charCodeAt(i))) return true;
  }
  return false;
}

/** Whether `value` carries any whitespace (Unicode `\s`) or control character. */
export function hasWhitespaceOrControl(value: string): boolean {
  return /\s/u.test(value) || hasControlCharacter(value);
}

export const ICLOUD_TEXT_REFUSAL = "must not contain a line break or other control character";
export const ICLOUD_TIME_REFUSAL =
  "must be a UTC time in the form YYYYMMDDTHHMMSSZ; all-day and floating times are not supported";
export const ICLOUD_UID_REFUSAL =
  "must be 1 to 200 characters, each a letter, a digit, '.', '_', '@' or '-'";
export const ICLOUD_ATTENDEE_REFUSAL =
  "each attendee must be one email address, with no whitespace or control character";

/** `YYYYMMDDTHHMMSSZ`: a UTC date-time and nothing else (owner ruling OR-B4-6). */
const UTC_DATE_TIME = /^\d{8}T\d{6}Z$/;
const EVENT_UID = /^[A-Za-z0-9._@-]{1,200}$/;

/** A free-text event field: refused, never cleaned, when it carries a control character. */
function eventText(): z.ZodString {
  return z.string().refine((s) => !hasControlCharacter(s), ICLOUD_TEXT_REFUSAL);
}

const createArgs = z.object({
  calendar: eventText().min(1).optional(),
  summary: eventText().min(1).max(1000),
  start: z.string().regex(UTC_DATE_TIME, ICLOUD_TIME_REFUSAL),
  end: z.string().regex(UTC_DATE_TIME, ICLOUD_TIME_REFUSAL),
  description: eventText().max(10_000).optional(),
  location: eventText().max(500).optional(),
  // z.email() already refuses whitespace and controls today; the explicit check keeps that a
  // stated property of THIS schema, not of zod's current email pattern.
  attendees: z
    .array(z.email().refine((s) => !hasWhitespaceOrControl(s), ICLOUD_ATTENDEE_REFUSAL))
    .optional(),
  uid: z.string().regex(EVENT_UID, ICLOUD_UID_REFUSAL).optional(),
});

const deleteArgs = z.object({
  href: z.string().min(1),
});

// ---------------------------------------------------------------------------
// ViewEvent — the shape returned to the LLM
// ---------------------------------------------------------------------------

interface ViewEvent {
  href: string;
  uid: string;
  summary: string | null;
  start: string | null;
  end: string | null;
  allDay: boolean;
  location: string | null;
  organizer: string | null;
  status: string | null;
  attendees: readonly string[];
  rrule: string | null;
  notes: string;
  calendar: string;
}

const DEFAULT_MAX_INSTANCES = 200;

/**
 * The apple connector's ONE write-scope configuration, for its mail and calendar writes alike.
 *
 * Both read NIMBUS_MCP_APPLE_WRITE_SCOPE, and the consent kit refuses at startup a scope term
 * whose kind its registrar did not declare. They used to be built by two registrars declaring one
 * kind each, so every non-empty scope was fatal: a `recipient:` term crashed the calendar
 * registrar and a `calendar:` term the mail one, leaving standalone apple unable to enable any
 * write at all. One registrar declaring both kinds also gives the connector one write budget,
 * where two had silently doubled it.
 */
export const APPLE_WRITE_SCOPE = {
  connector: "apple",
  scopeEnv: "NIMBUS_MCP_APPLE_WRITE_SCOPE",
  scopeKinds: ["recipient", "calendar"],
} as const;

// ---------------------------------------------------------------------------
// registerAppleCalendarTools
// ---------------------------------------------------------------------------

/**
 * Register the three iCloud Calendar tools onto an MCP server.
 *
 * @param server  - The MCP server instance.
 * @param options - Injected dependencies: the CalDAV client, a `now` factory
 *                  (returns the current UTC timestamp in iCalendar DTSTAMP
 *                  format, e.g. "20260601T090000Z"), optional config, and the
 *                  write registrar to share with the connector's mail writes
 *                  (built from {@link APPLE_WRITE_SCOPE} when omitted).
 */
export function registerAppleCalendarTools(
  // Widened: the consent kit needs the real server surface, not just the `.tool` shim.
  server: ConsentServer & { tool: (...args: never) => unknown },
  options: {
    calendar: CalDavClient;
    now: () => string;
    config?: CalendarToolConfig | undefined;
    registerWriteTool?: WriteToolRegistrar | undefined;
  },
): void {
  const { calendar, now, config } = options;
  const maxInstances = config?.maxInstances ?? DEFAULT_MAX_INSTANCES;
  const registerSimpleTool = createRegisterSimpleTool(server);

  // -------------------------------------------------------------------------
  // apple_calendar_list
  // -------------------------------------------------------------------------

  registerSimpleTool(
    "apple_calendar_list",
    "List events across iCloud Calendar within a UTC time window. Returns event summaries, start/end times, location, organizer, attendee emails, and a <=2000-char notes preview. NEVER returns full event descriptions beyond the capped preview.",
    listArgs.shape,
    async (args: unknown) => {
      const parsed = listArgs.safeParse(args);
      if (!parsed.success) {
        throw new Error(parsed.error.message);
      }

      const window = { startUtc: parsed.data.startUtc, endUtc: parsed.data.endUtc };

      let allCals = await calendar.listCalendars();

      // Filter by caller-supplied single calendar name or global config
      if (parsed.data.calendar === undefined) {
        allCals = selectCalendars(allCals, {
          include: config?.include,
          exclude: config?.exclude,
        });
      } else {
        allCals = selectCalendars(allCals, { include: [parsed.data.calendar] });
      }

      const items: ViewEvent[] = [];

      for (const cal of allCals) {
        const rows = await calendar.listEvents(cal, window); // NOSONAR S9382: calendars are queried in order until maxInstances is reached — each clamp depends on how many events the earlier calendars returned, and a calendar past the cap is never queried at all.
        const clamped = clampInstances(rows, maxInstances - items.length);

        for (const { href, event } of clamped) {
          items.push({
            href,
            uid: event.uid,
            summary: event.summary,
            start: event.start,
            end: event.end,
            allDay: event.allDay,
            location: event.location,
            organizer: event.organizer,
            status: event.status,
            attendees: event.attendees,
            rrule: event.rrule,
            notes: capPreview(event.description ?? ""),
            calendar: cal.displayName,
          });
        }

        if (items.length >= maxInstances) {
          break;
        }
      }

      return mcpJsonResult({ items });
    },
  );

  // -------------------------------------------------------------------------
  // apple_calendar_event_get
  // -------------------------------------------------------------------------

  registerSimpleTool(
    "apple_calendar_event_get",
    "Get one iCloud Calendar event by its object href (as apple_calendar_list returns it), with its ETag. The href must be under one of your calendars. The before-state of apple_calendar_event_delete; same href.",
    deleteArgs.shape,
    async (args: unknown) => {
      const parsed = deleteArgs.safeParse(args);
      if (!parsed.success) {
        throw new Error(parsed.error.message);
      }
      const { calendar: calendarName, etag, event } = await calendar.getEvent(parsed.data.href);
      const view: ViewEvent & { etag: string | null } = {
        href: parsed.data.href,
        uid: event.uid,
        summary: event.summary,
        start: event.start,
        end: event.end,
        allDay: event.allDay,
        location: event.location,
        organizer: event.organizer,
        status: event.status,
        attendees: event.attendees,
        rrule: event.rrule,
        notes: capPreview(event.description ?? ""),
        calendar: calendarName,
        etag,
      };
      return mcpJsonResult(view);
    },
  );

  // -------------------------------------------------------------------------
  // apple_calendar_event_create
  // -------------------------------------------------------------------------

  const registerWriteTool =
    options.registerWriteTool ?? createWriteToolRegistrar(server, APPLE_WRITE_SCOPE);

  registerWriteTool(
    "apple_calendar_event_create",
    {
      mutates: "apple.calendar.event.create",
      recoverable: true,
      scopeTargetOf: (p) => ({ kind: "calendar", value: p.calendar ?? "default" }),
    },
    "Create a new event in iCloud Calendar via CalDAV PUT. start and end are UTC, in the form YYYYMMDDTHHMMSSZ (all-day and floating times are refused). summary, description, location and calendar may not contain a line break or other control character; uid, when given, is 1-200 of A-Z a-z 0-9 . _ @ -.",
    createArgs,
    async (parsedData) => {
      const parsed = { success: true as const, data: parsedData };

      // Resolve the target calendar
      let targetCal: CalendarRef | undefined;
      const allCals = await calendar.listCalendars();

      if (parsed.data.calendar === undefined) {
        const selected = selectCalendars(allCals, {
          include: config?.include,
          exclude: config?.exclude,
        });
        targetCal = selected[0];
        if (targetCal === undefined) {
          throw new Error("No calendar available to create the event in");
        }
      } else {
        targetCal = selectCalendars(allCals, { include: [parsed.data.calendar] })[0];
        if (targetCal === undefined) {
          throw new Error(`Calendar "${parsed.data.calendar}" not found`);
        }
      }

      // Capture a single timestamp so the derived UID and the DTSTAMP never
      // diverge (the injected now() returns a fresh value on each call).
      const stamp = now();
      // Determine UID: caller may supply one (for deterministic tests; Zod
      // rejects ""); otherwise derive from the captured stamp + summary to
      // avoid a non-pure Date.now().
      const uid =
        parsed.data.uid ??
        `nimbus-${stamp}-${parsed.data.summary.slice(0, 40).replace(/\s+/g, "-")}`;

      // Build the VEVENT ICS string
      const buildInput: {
        uid: string;
        summary: string;
        start: string;
        end: string;
        description?: string;
        location?: string;
        attendees?: readonly string[];
      } = {
        uid,
        summary: parsed.data.summary,
        start: parsed.data.start,
        end: parsed.data.end,
      };
      if (parsed.data.description !== undefined) {
        buildInput.description = parsed.data.description;
      }
      if (parsed.data.location !== undefined) {
        buildInput.location = parsed.data.location;
      }
      if (parsed.data.attendees !== undefined && parsed.data.attendees.length > 0) {
        buildInput.attendees = parsed.data.attendees;
      }

      const ics = buildVEvent(buildInput, stamp);

      // PUT the event to the CalDAV server
      const { href } = await calendar.putEvent(targetCal, uid, ics);

      return mcpJsonResult({ uid, href });
    },
  );

  // -------------------------------------------------------------------------
  // apple_calendar_event_delete
  // -------------------------------------------------------------------------

  registerWriteTool(
    "apple_calendar_event_delete",
    {
      mutates: "apple.calendar.event.delete",
      // A deleted CalDAV event is gone from the server; the href is all that identifies it
      // afterwards, so it IS the pre-state.
      recoverable: false,
      capturePreState: (p) => Promise.resolve({ href: p.href }),
      scopeTargetOf: (p) => ({ kind: "calendar", value: p.href }),
    },
    "Delete an event from iCloud Calendar via CalDAV DELETE by href.",
    deleteArgs,
    async (parsedData) => {
      const parsed = { success: true as const, data: parsedData };

      await calendar.deleteEvent(parsed.data.href);

      return mcpJsonResult({ deleted: true });
    },
  );
}

// Re-export the types needed by tests and tools.ts
export type { CalDavClient, CalendarRef };
