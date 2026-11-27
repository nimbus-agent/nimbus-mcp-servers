import { z } from "zod";
import { type ConsentServer, createWriteToolRegistrar } from "../../../shared/consent-kit.ts";
import { resolveUrlWithBase } from "../../../shared/fetch-bearer-json.ts";
import { guardedFetch } from "../../../shared/guarded-fetch.ts";
import {
  createRegisterSimpleTool,
  createZodToolRegistrar,
  mcpJsonResult,
  requireProcessEnv,
} from "../../../shared/mcp-tool-kit.ts";
import {
  makeRestToolRegistrar,
  makeRestWriteToolRegistrar,
  type RestFetchResult,
  toRestFetchResult,
} from "../../../shared/rest-tool-kit.ts";
import { calendarWritesAllowed, parseGoogleOAuthScopesFromEnv } from "./tool-scope-policy.ts";

const CALENDAR_BASE = "https://www.googleapis.com/calendar/v3";
const SERVICE_LABEL = "Google Calendar API";
const TOKEN_ENV = "GOOGLE_OAUTH_ACCESS_TOKEN";

/** The most the API returns per page for both lists. Larger values are refused, not clamped. */
const MAX_PAGE = 250;
/** Upstream body characters quoted in an error. */
const SNIPPET_MAX = 300;
const MAX_ATTENDEES = 100;
const MAX_RECURRENCE_LINES = 10;

/**
 * Every request, read or write, goes through `guardedFetch`: a write refuses any redirect (the
 * token never follows one, and a replayed write is not ours to decide), and a read follows only a
 * same-origin one.
 */
async function calendarFetch(
  token: string,
  path: string,
  init?: RequestInit,
): Promise<RestFetchResult> {
  const url = resolveUrlWithBase(CALENDAR_BASE, path);
  const res = await guardedFetch(SERVICE_LABEL, url, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  });
  return toRestFetchResult(res);
}

/** An id that becomes a path segment: bounded, and never a dot segment a URL parser would resolve. */
function pathId(max: number) {
  return z
    .string()
    .min(1)
    .max(max)
    .refine((value) => value !== "." && value !== "..", "must not be a dot segment");
}

/** RFC 3339 with an explicit offset or Z: the API reads an offset-less time in an unstated zone. */
const rfc3339 = z.iso.datetime({ offset: true });

const pageSize = z.number().int().min(1).max(MAX_PAGE);

const calendarListArgs = z.object({
  maxResults: pageSize.optional(),
  pageToken: z.string().min(1).max(2048).optional(),
});

const eventListArgs = z
  .object({
    calendarId: pathId(256).optional(),
    timeMin: rfc3339,
    timeMax: rfc3339,
    maxResults: pageSize.optional(),
    pageToken: z.string().min(1).max(2048).optional(),
  })
  .refine((a) => Date.parse(a.timeMax) > Date.parse(a.timeMin), {
    message: "timeMax must be after timeMin",
    path: ["timeMax"],
  });

const eventGetArgs = z.object({
  calendarId: pathId(256).optional(),
  eventId: pathId(1024),
});

function calendarListPath(args: z.infer<typeof calendarListArgs>): string {
  const query = new URLSearchParams({ maxResults: String(args.maxResults ?? 100) });
  if (args.pageToken !== undefined) {
    query.set("pageToken", args.pageToken);
  }
  return `/users/me/calendarList?${query.toString()}`;
}

function eventsPath(calendarId: string | undefined): string {
  return `/calendars/${encodeURIComponent(calendarId ?? "primary")}/events`;
}

function eventPath(args: { calendarId?: string | undefined; eventId: string }): string {
  return `${eventsPath(args.calendarId)}/${encodeURIComponent(args.eventId)}`;
}

/** Recurring events are expanded (`singleEvents`), so each result is one occurrence in the window. */
function eventListPath(args: z.infer<typeof eventListArgs>): string {
  const query = new URLSearchParams({
    singleEvents: "true",
    orderBy: "startTime",
    timeMin: args.timeMin,
    timeMax: args.timeMax,
    maxResults: String(args.maxResults ?? 50),
  });
  if (args.pageToken !== undefined) {
    query.set("pageToken", args.pageToken);
  }
  return `${eventsPath(args.calendarId)}?${query.toString()}`;
}

// ---------------------------------------------------------------------------------------------
// Write arguments
// ---------------------------------------------------------------------------------------------

/** A zone name the runtime knows: `Europe/Berlin`, `UTC`. An offset such as `+02:00` is not one. */
function isIanaTimeZone(value: string): boolean {
  if (!/^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+)*$/.test(value)) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

const ianaTimeZone = z
  .string()
  .min(1)
  .max(64)
  .refine(isIanaTimeZone, "timeZone must be an IANA time zone name such as Europe/Berlin");

/** One end of an event: `{ dateTime, timeZone? }` (timed) or `{ date }` (all day), never both. */
const eventTime = z
  .strictObject({
    dateTime: rfc3339.optional(),
    timeZone: ianaTimeZone.optional(),
    date: z.iso.date().optional(),
  })
  .refine(
    (t) => (t.dateTime === undefined) !== (t.date === undefined),
    "give exactly one of dateTime (a timed event) or date (an all-day event)",
  )
  .refine(
    (t) => t.date === undefined || t.timeZone === undefined,
    "timeZone goes with dateTime, not with an all-day date",
  );

type EventTime = z.infer<typeof eventTime>;

/**
 * An RFC 5545 recurrence line Google accepts in `recurrence`: RRULE, EXRULE, RDATE or EXDATE, with a
 * value and no parameters. A line break is refused first and by name: it would start another
 * iCalendar property inside the line.
 */
const recurrenceLine = z
  .string()
  .max(1024)
  .refine((line) => !/[\r\n]/.test(line), "must not contain a line break")
  .refine(
    // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what this refuses.
    (line) => /^(?:RRULE|EXRULE|RDATE|EXDATE):[^\u0000-\u001f\u007f]+$/.test(line),
    "must start with RRULE:, EXRULE:, RDATE: or EXDATE: and hold no control character",
  );

const recurrence = z.array(recurrenceLine).min(1).max(MAX_RECURRENCE_LINES);

/** Guest emails. A repeat (ignoring case) is refused rather than silently merged. */
const attendees = z
  .array(z.email().max(254))
  .max(MAX_ATTENDEES)
  .refine(
    (list) => new Set(list.map((e) => e.toLowerCase())).size === list.length,
    "attendees must not name the same email twice",
  );

const sendUpdates = z.enum(["none", "externalOnly", "all"]).optional();

const summary = z.string().min(1).max(1024);
const description = z.string().max(8192);
const location = z.string().max(1024);

const eventCreateArgs = z.object({
  calendarId: pathId(256).optional(),
  summary,
  description: description.optional(),
  location: location.optional(),
  start: eventTime,
  end: eventTime,
  attendees: attendees.optional(),
  recurrence: recurrence.optional(),
  sendUpdates,
});

const eventUpdateArgs = z.object({
  calendarId: pathId(256).optional(),
  eventId: pathId(1024),
  summary: summary.optional(),
  description: description.optional(),
  location: location.optional(),
  start: eventTime.optional(),
  end: eventTime.optional(),
  attendees: attendees.optional(),
  recurrence: recurrence.optional(),
  sendUpdates,
});

const eventDeleteArgs = z.object({
  calendarId: pathId(256).optional(),
  eventId: pathId(1024),
  sendUpdates,
});

type EventCreateArgs = z.infer<typeof eventCreateArgs>;
type EventUpdateArgs = z.infer<typeof eventUpdateArgs>;
type EventDeleteArgs = z.infer<typeof eventDeleteArgs>;

/**
 * The cross-field rules for an event's times, as a refusal or `undefined`. A plain object schema
 * cannot carry them (the write registrar needs `.shape`), so this runs as `refuseBefore`
 * (standalone, before the prompt) and again in the handler (gateway mode skips `refuseBefore`).
 */
function timesProblem(
  start: EventTime | undefined,
  end: EventTime | undefined,
  recurring: boolean,
): string | undefined {
  if (start === undefined && end === undefined) return undefined;
  if (start === undefined || end === undefined) return "start and end must be given together";
  if ((start.date === undefined) !== (end.date === undefined)) {
    return "start and end must be the same kind: both dateTime (a timed event) or both date (an all-day event)";
  }
  if (start.date !== undefined && end.date !== undefined) {
    return end.date > start.date
      ? undefined
      : "end.date must be after start.date: Google's end date is exclusive, so a one-day event on 2026-12-01 ends on 2026-12-02";
  }
  if (Date.parse(end.dateTime ?? "") <= Date.parse(start.dateTime ?? "")) {
    return "end.dateTime must be after start.dateTime";
  }
  if (recurring && (start.timeZone === undefined || end.timeZone === undefined)) {
    return "a recurring timed event needs start.timeZone and end.timeZone (an IANA name such as Europe/Berlin): Google expands the recurrence in that zone";
  }
  return undefined;
}

function createProblem(args: EventCreateArgs): string | undefined {
  return timesProblem(args.start, args.end, args.recurrence !== undefined);
}

function updateProblem(args: EventUpdateArgs): string | undefined {
  const changes = [
    args.summary,
    args.description,
    args.location,
    args.start,
    args.end,
    args.attendees,
    args.recurrence,
  ];
  if (changes.every((field) => field === undefined)) {
    return "gcal_event_update needs at least one of summary, description, location, start and end, attendees, recurrence";
  }
  return timesProblem(args.start, args.end, args.recurrence !== undefined);
}

/** Who Google emails about the change. Always sent, so Google's own default never applies. */
function withSendUpdates(path: string, value: EventCreateArgs["sendUpdates"]): string {
  return `${path}?${new URLSearchParams({ sendUpdates: value ?? "none" }).toString()}`;
}

/** An event time as created: only the kind given. */
function createdTime(t: EventTime): Record<string, string> {
  if (t.date !== undefined) return { date: t.date };
  return {
    dateTime: t.dateTime ?? "",
    ...(t.timeZone === undefined ? {} : { timeZone: t.timeZone }),
  };
}

/**
 * An event time as patched: the other kind is cleared explicitly, so moving a timed event to all
 * day (or back) cannot leave both `date` and `dateTime` on it, whether Google merges or replaces.
 */
function patchedTime(t: EventTime): Record<string, string | null> {
  if (t.date !== undefined) return { date: t.date, dateTime: null };
  return {
    dateTime: t.dateTime ?? "",
    date: null,
    ...(t.timeZone === undefined ? {} : { timeZone: t.timeZone }),
  };
}

function guestList(emails: readonly string[]): { email: string }[] {
  return emails.map((email) => ({ email }));
}

function createBody(args: EventCreateArgs): Record<string, unknown> {
  return {
    summary: args.summary,
    ...(args.description === undefined ? {} : { description: args.description }),
    ...(args.location === undefined ? {} : { location: args.location }),
    start: createdTime(args.start),
    end: createdTime(args.end),
    ...(args.attendees === undefined ? {} : { attendees: guestList(args.attendees) }),
    ...(args.recurrence === undefined ? {} : { recurrence: args.recurrence }),
  };
}

/** Only the fields given: a PATCH leaves every other field as it is. */
function updateBody(args: EventUpdateArgs): Record<string, unknown> {
  return {
    ...(args.summary === undefined ? {} : { summary: args.summary }),
    ...(args.description === undefined ? {} : { description: args.description }),
    ...(args.location === undefined ? {} : { location: args.location }),
    ...(args.start === undefined ? {} : { start: patchedTime(args.start) }),
    ...(args.end === undefined ? {} : { end: patchedTime(args.end) }),
    ...(args.attendees === undefined ? {} : { attendees: guestList(args.attendees) }),
    ...(args.recurrence === undefined ? {} : { recurrence: args.recurrence }),
  };
}

function jsonInit(method: string, body: unknown): RequestInit {
  return { method, body: JSON.stringify(body) };
}

/** The event fields an inverse would need, as recorded before an update or a delete. */
const PRE_STATE_FIELDS = [
  "id",
  "status",
  "summary",
  "description",
  "location",
  "start",
  "end",
  "attendees",
  "recurrence",
  "recurringEventId",
] as const;

async function capturedEvent(args: {
  calendarId?: string | undefined;
  eventId: string;
}): Promise<Record<string, unknown>> {
  const res = await calendarFetch(requireProcessEnv(TOKEN_ENV), eventPath(args));
  if (!res.ok || typeof res.json !== "object" || res.json === null) {
    return { resolved: false, status: res.status };
  }
  const event = res.json as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const field of PRE_STATE_FIELDS) {
    if (event[field] !== undefined) out[field] = event[field];
  }
  return out;
}

function calendarTarget(args: { calendarId?: string | undefined }): {
  kind: string;
  value: string;
} {
  return { kind: "calendar", value: args.calendarId ?? "primary" };
}

const SEND_UPDATES_TEXT =
  "sendUpdates decides who Google emails: none (the default) emails nobody, externalOnly emails only guests who do not use Google Calendar, all emails every guest.";
const EXACT_ID_TEXT =
  "It acts on exactly the eventId given: a recurring series' id affects every occurrence, an instance id (as gcal_event_list returns, since it expands recurring events) affects that one occurrence.";

export function registerGoogleCalendarTools(
  server: ConsentServer & { tool: (...args: never) => unknown },
): void {
  const reg = createZodToolRegistrar(createRegisterSimpleTool(server));

  const calendarRest = {
    tokenEnv: TOKEN_ENV,
    serviceLabel: SERVICE_LABEL,
    fetch: calendarFetch,
    snippetMax: SNIPPET_MAX,
  } as const;

  const registerCalendarTool = makeRestToolRegistrar({ registrar: reg, ...calendarRest });

  registerCalendarTool(
    "gcal_calendar_list",
    "List the calendars the user can see (id, summary, accessRole, timeZone). One page; pass pageToken for the next.",
    calendarListArgs,
    calendarListPath,
  );

  registerCalendarTool(
    "gcal_event_list",
    "List events in a calendar between timeMin and timeMax (RFC 3339 with offset), recurring events expanded, ordered by start. One page of up to 250; pass pageToken for the next. calendarId defaults to primary.",
    eventListArgs,
    eventListPath,
  );

  registerCalendarTool(
    "gcal_event_get",
    "Get one calendar event by id (summary, start, end, attendees, location). calendarId defaults to primary.",
    eventGetArgs,
    eventPath,
  );

  // The writes register only for a token holding a calendar write scope: the connector's original
  // grant is calendar.readonly, and a read-only token must not list a write it cannot perform.
  if (!calendarWritesAllowed(parseGoogleOAuthScopesFromEnv())) return;

  /**
   * Every MUTATING calendar tool goes through here. Outside the gateway this adds the consent
   * gate, the write-scope allow-list, the mutation budget and the audit record; inside the gateway
   * it is a pass-through, because the gateway is the gate there.
   */
  const registerWriteTool = createWriteToolRegistrar(server, {
    connector: "google-calendar",
    scopeEnv: "NIMBUS_MCP_GOOGLE_CALENDAR_WRITE_SCOPE",
    scopeKinds: ["calendar"],
  });

  const registerCalendarWriteTool = makeRestWriteToolRegistrar({
    registerWriteTool,
    ...calendarRest,
  });

  registerCalendarWriteTool(
    "gcal_event_create",
    {
      mutates: "google_calendar.event.create",
      // Its inverse is gcal_event_delete of the id it returns.
      recoverable: true,
      scopeTargetOf: calendarTarget,
      refuseBefore: createProblem,
    },
    `Create an event in a calendar (calendarId defaults to primary). start and end are both { dateTime: RFC 3339 with offset, timeZone?: IANA name } for a timed event, or both { date: YYYY-MM-DD } for an all-day one, and end must be after start; an all-day end date is exclusive, so a one-day event on 2026-12-01 ends on 2026-12-02. Optional description, location, attendees (guest emails) and recurrence (RRULE:, EXRULE:, RDATE: or EXDATE: lines; a recurring timed event needs timeZone on both ends). No Meet link is added. ${SEND_UPDATES_TEXT}`,
    eventCreateArgs,
    (args) => withSendUpdates(eventsPath(args.calendarId), args.sendUpdates),
    (args) => {
      const problem = createProblem(args);
      if (problem !== undefined) throw new Error(problem);
      return jsonInit("POST", createBody(args));
    },
  );

  registerCalendarWriteTool(
    "gcal_event_update",
    {
      mutates: "google_calendar.event.update",
      // An edit overwrites fields; its inverse needs the old values, so capture them first.
      recoverable: false,
      capturePreState: capturedEvent,
      scopeTargetOf: calendarTarget,
      refuseBefore: updateProblem,
    },
    `Change an event: only the fields given change, and at least one of summary, description, location, start and end, attendees, recurrence is required. start and end are given together, with gcal_event_create's rules. attendees REPLACES the whole guest list: anyone not named is removed, and [] removes every guest. ${EXACT_ID_TEXT} ${SEND_UPDATES_TEXT}`,
    eventUpdateArgs,
    (args) => withSendUpdates(eventPath(args), args.sendUpdates),
    (args) => {
      const problem = updateProblem(args);
      if (problem !== undefined) throw new Error(problem);
      return jsonInit("PATCH", updateBody(args));
    },
  );

  registerWriteTool(
    "gcal_event_delete",
    {
      mutates: "google_calendar.event.delete",
      // The API has no undelete, so the event is captured first.
      recoverable: false,
      capturePreState: capturedEvent,
      scopeTargetOf: calendarTarget,
    },
    `Delete an event. ${EXACT_ID_TEXT} ${SEND_UPDATES_TEXT} An event that was already deleted is reported as alreadyDeleted, not as deleted.`,
    eventDeleteArgs,
    async (args: EventDeleteArgs) => {
      const token = requireProcessEnv(TOKEN_ENV);
      const res = await calendarFetch(token, withSendUpdates(eventPath(args), args.sendUpdates), {
        method: "DELETE",
      });
      const calendarId = args.calendarId ?? "primary";
      if (res.status === 410) {
        return mcpJsonResult({
          deleted: false,
          alreadyDeleted: true,
          calendarId,
          eventId: args.eventId,
          message:
            "Google Calendar answered 410 Gone: the event was already deleted, so this call deleted nothing",
        });
      }
      if (!res.ok) {
        throw new Error(
          `${SERVICE_LABEL} ${String(res.status)}: ${res.text.slice(0, SNIPPET_MAX)}`,
        );
      }
      return mcpJsonResult({ deleted: true, calendarId, eventId: args.eventId });
    },
  );
}
