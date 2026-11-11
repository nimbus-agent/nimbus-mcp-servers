import { z } from "zod";
import {
  fetchBearerAuthorizedJson,
  resolveUrlWithBase,
} from "../../../shared/fetch-bearer-json.ts";
import { createRegisterSimpleTool, createZodToolRegistrar } from "../../../shared/mcp-tool-kit.ts";
import { makeRestToolRegistrar } from "../../../shared/rest-tool-kit.ts";

export const GOOGLE_CALENDAR_TOOL_NAMES = [
  "gcal_calendar_list",
  "gcal_event_list",
  "gcal_event_get",
] as const;

const CALENDAR_BASE = "https://www.googleapis.com/calendar/v3";

/** The most the API returns per page for both lists. Larger values are refused, not clamped. */
const MAX_PAGE = 250;

async function calendarFetch(
  token: string,
  path: string,
  init?: RequestInit,
): Promise<{ ok: boolean; status: number; json: unknown; text: string }> {
  const url = resolveUrlWithBase(CALENDAR_BASE, path);
  return fetchBearerAuthorizedJson(url, token, init, { "Content-Type": "application/json" });
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
  return `/calendars/${encodeURIComponent(args.calendarId ?? "primary")}/events?${query.toString()}`;
}

export function registerGoogleCalendarTools(server: { tool: (...args: never) => unknown }): void {
  const registerSimpleTool = createRegisterSimpleTool(server);
  const reg = createZodToolRegistrar(registerSimpleTool);

  /** Read-only: every tool is a GET, so there is no write registrar in this connector. */
  const registerCalendarTool = makeRestToolRegistrar({
    registrar: reg,
    tokenEnv: "GOOGLE_OAUTH_ACCESS_TOKEN",
    serviceLabel: "Google Calendar API",
    fetch: calendarFetch,
  });

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
    (args) =>
      `/calendars/${encodeURIComponent(args.calendarId ?? "primary")}/events/${encodeURIComponent(args.eventId)}`,
  );
}
