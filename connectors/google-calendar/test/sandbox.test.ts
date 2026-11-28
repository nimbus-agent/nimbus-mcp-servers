import { describe, expect, it } from "bun:test";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runSandboxContractTests } from "@nimbus-dev/sdk/testing";
import {
  approvedStandaloneWrite,
  captureStandaloneTools,
  withEnv,
} from "../../../scripts/connector-tool-harness.ts";
import {
  LIVE_TEST_TIMEOUT_MS,
  liveSandboxGate,
  sandboxName,
  withCleanup,
} from "../../../scripts/sandbox-live-env.ts";
import { resetConnectorModeForTests, setConnectorMode } from "../../../shared/connector-mode.ts";
import { registerGoogleCalendarTools } from "../src/tools.ts";

const manifestPath = resolve(fileURLToPath(import.meta.url), "../../nimbus.extension.json");

describe.skipIf(!process.env["NIMBUS_TEST_HARNESS"])("sandbox contract", () => {
  it("respects declared permissions", async () => {
    await expect(runSandboxContractTests(manifestPath)).resolves.toBeUndefined();
  });
});

/**
 * LIVE: creates, changes and deletes events it made itself, in ONE throwaway calendar the owner
 * created and names in GCAL_SANDBOX_CALENDAR_ID. No attendees, `sendUpdates: "none"`. Runs only
 * under `bun run test:sandbox` with every variable set.
 */
const live = liveSandboxGate(
  "google-calendar live writes: gcal_event_create, gcal_event_update, gcal_event_delete",
  ["GOOGLE_OAUTH_ACCESS_TOKEN", "GOOGLE_OAUTH_SCOPES", "GCAL_SANDBOX_CALENDAR_ID"],
);

/** A secondary calendar's id; the primary calendar's id is `primary` or the account's own email. */
const SECONDARY_CALENDAR = /@group\.calendar\.google\.com$/;

/**
 * The throwaway calendar, or a refusal. `primary` and any id that is not a secondary calendar's
 * (the primary calendar's id is the account's email) are refused before anything is sent.
 */
function throwawayCalendar(): string {
  const id = live.values["GCAL_SANDBOX_CALENDAR_ID"] ?? "";
  if (id.toLowerCase() === "primary" || !SECONDARY_CALENDAR.test(id)) {
    throw new Error(
      "GCAL_SANDBOX_CALENDAR_ID must be a throwaway SECONDARY calendar (an id ending in @group.calendar.google.com), never primary or your own email; nothing was sent",
    );
  }
  return id;
}

const DAY_MS = 86_400_000;

/** `YYYY-MM-DD` of a UTC instant. */
function isoDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** RFC 3339 in UTC, whole seconds. */
function isoTime(ms: number): string {
  return `${new Date(ms).toISOString().slice(0, 19)}Z`;
}

/** `YYYYMMDDTHHMMSS` of an instant as wall-clock time in `timeZone` (an iCalendar local time). */
function icalLocal(ms: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(ms));
  const part = (type: string): string => parts.find((p) => p.type === type)?.value ?? "";
  return `${part("year")}${part("month")}${part("day")}T${part("hour")}${part("minute")}${part("second")}`;
}

/** The same iCalendar local time (`YYYYMMDDTHHMMSS`) one calendar day later. */
function nextLocalDay(local: string): string {
  const date = new Date(
    Date.UTC(
      Number(local.slice(0, 4)),
      Number(local.slice(4, 6)) - 1,
      Number(local.slice(6, 8)) + 1,
    ),
  );
  return `${date.toISOString().slice(0, 10).replaceAll("-", "")}${local.slice(8)}`;
}

function record(value: unknown): Record<string, unknown> {
  expect(typeof value).toBe("object");
  expect(value).not.toBeNull();
  return value as Record<string, unknown>;
}

describe.skipIf(!live.enabled)(live.title, () => {
  // Two weeks out, at 10:00 UTC: far enough from now that no reminder fires during the run.
  const dayStart = Math.floor(Date.now() / DAY_MS) * DAY_MS + 14 * DAY_MS;
  const tenUtc = dayStart + 10 * 3_600_000;

  /**
   * Run `body` in standalone mode, where the connector's own consent kit is the gate. Not a
   * beforeAll/afterAll pair: Bun counts a skipped describe's hooks as skipped tests.
   */
  async function standalone(body: () => Promise<void>): Promise<void> {
    resetConnectorModeForTests();
    setConnectorMode("standalone");
    try {
      await body();
    } finally {
      resetConnectorModeForTests();
    }
  }

  function scopeFor(calendarId: string): Record<string, string> {
    // The write scope names only the throwaway calendar, so the consent kit refuses any other.
    return { NIMBUS_MCP_GOOGLE_CALENDAR_WRITE_SCOPE: `calendar:${calendarId}` };
  }

  /** One write through the real consent flow, approved by the harness's stand-in client. */
  async function write(
    calendarId: string,
    tool: "gcal_event_create" | "gcal_event_update" | "gcal_event_delete",
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const run = await approvedStandaloneWrite(
      registerGoogleCalendarTools,
      scopeFor(calendarId),
      tool,
      {
        calendarId,
        sendUpdates: "none",
        ...args,
      },
    );
    expect(run.chain.ok).toBe(true);
    return record(run.answer);
  }

  async function read(
    tool: string,
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    // Registered under the same scope as the writes, so the kit does not warn about an unset one.
    const answer = await withEnv(scopeFor(String(args["calendarId"])), () =>
      captureStandaloneTools(registerGoogleCalendarTools, { elicitation: true }).tools.callJson(
        tool,
        args,
      ),
    );
    return record(answer);
  }

  /** Delete `eventId` if it still exists; an already-deleted event is fine. Cleanup only. */
  async function deleteIfPresent(calendarId: string, eventId: string | undefined): Promise<void> {
    if (eventId === undefined) return;
    const answer = await write(calendarId, "gcal_event_delete", { eventId });
    expect(answer["deleted"] === true || answer["alreadyDeleted"] === true).toBe(true);
  }

  it(
    "creates a timed event, renames it, moves it to all-day and back, deletes it twice",
    () =>
      standalone(async () => {
        const calendarId = throwawayCalendar();
        let eventId: string | undefined;
        let deleted = false;

        await withCleanup(
          () => `event ${eventId ?? "(id unknown: look for nimbus-sandbox-*)"} in ${calendarId}`,
          async () => {
            const created = await write(calendarId, "gcal_event_create", {
              summary: sandboxName("timed"),
              description: "Created by the nimbus-mcp-servers live sandbox test; deleted by it.",
              start: { dateTime: isoTime(tenUtc) },
              end: { dateTime: isoTime(tenUtc + 3_600_000) },
            });
            expect(typeof created["id"]).toBe("string");
            eventId = String(created["id"]);
            expect(created["attendees"]).toBeUndefined();

            const renamedTo = sandboxName("renamed");
            const renamed = await write(calendarId, "gcal_event_update", {
              eventId,
              summary: renamedTo,
            });
            expect(renamed["summary"]).toBe(renamedTo);

            // Timed -> all day: the PATCH sends `dateTime: null` beside `date`. A live API that kept
            // the dateTime, or refused the null, fails here.
            const allDay = await write(calendarId, "gcal_event_update", {
              eventId,
              start: { date: isoDate(dayStart) },
              end: { date: isoDate(dayStart + DAY_MS) },
            });
            expect(record(allDay["start"])["date"]).toBe(isoDate(dayStart));
            expect(record(allDay["start"])["dateTime"]).toBeUndefined();
            expect(record(allDay["end"])["date"]).toBe(isoDate(dayStart + DAY_MS));
            expect(record(allDay["end"])["dateTime"]).toBeUndefined();

            // All day -> timed: `date: null` beside `dateTime`.
            const timed = await write(calendarId, "gcal_event_update", {
              eventId,
              start: { dateTime: isoTime(tenUtc), timeZone: "UTC" },
              end: { dateTime: isoTime(tenUtc + 3_600_000), timeZone: "UTC" },
            });
            const start = record(timed["start"]);
            expect(start["date"]).toBeUndefined();
            expect(Date.parse(String(start["dateTime"]))).toBe(tenUtc);
            expect(record(timed["end"])["date"]).toBeUndefined();

            const fetched = await read("gcal_event_get", { calendarId, eventId });
            expect(fetched["summary"]).toBe(renamedTo);

            expect(await write(calendarId, "gcal_event_delete", { eventId })).toEqual({
              deleted: true,
              calendarId,
              eventId,
            });
            deleted = true;

            // Google answers 410 Gone for an event that is already deleted.
            expect(await write(calendarId, "gcal_event_delete", { eventId })).toMatchObject({
              deleted: false,
              alreadyDeleted: true,
              calendarId,
              eventId,
            });
          },
          async () => {
            if (!deleted) await deleteIfPresent(calendarId, eventId);
          },
        );
      }),
    LIVE_TEST_TIMEOUT_MS,
  );

  it(
    "creates a recurring event with an RRULE and an EXDATE;TZID line, then deletes it",
    () =>
      standalone(async () => {
        const calendarId = throwawayCalendar();
        const timeZone = "Europe/Berlin";
        // Three daily occurrences; the EXDATE removes the second, named in Berlin wall-clock time.
        // A daily series keeps its local clock time, so the second occurrence is the next local
        // calendar day at the first one's local time, not 24 elapsed hours later: across a DST
        // change those differ by an hour and the EXDATE would exclude nothing.
        const exdate = `EXDATE;TZID=${timeZone}:${nextLocalDay(icalLocal(tenUtc, timeZone))}`;
        let eventId: string | undefined;
        let deleted = false;

        await withCleanup(
          () =>
            `recurring event ${eventId ?? "(id unknown: look for nimbus-sandbox-*)"} in ${calendarId}`,
          async () => {
            const created = await write(calendarId, "gcal_event_create", {
              summary: sandboxName("recurring"),
              start: { dateTime: isoTime(tenUtc), timeZone },
              end: { dateTime: isoTime(tenUtc + 3_600_000), timeZone },
              recurrence: ["RRULE:FREQ=DAILY;COUNT=3", exdate],
            });
            expect(typeof created["id"]).toBe("string");
            eventId = String(created["id"]);
            console.error(`[live sandbox] google-calendar: recurring event ${eventId} created`);
            const lines = created["recurrence"];
            expect(Array.isArray(lines)).toBe(true);
            expect(
              (lines as unknown[]).some((l) => typeof l === "string" && l.startsWith("EXDATE")),
            ).toBe(true);

            // The expanded instances in the window: three occurrences less the excluded one.
            const listed = await read("gcal_event_list", {
              calendarId,
              timeMin: isoTime(tenUtc - 3_600_000),
              timeMax: isoTime(tenUtc + 3 * DAY_MS),
            });
            const items = Array.isArray(listed["items"]) ? (listed["items"] as unknown[]) : [];
            const instances = items.filter(
              (i) => (i as Record<string, unknown> | null)?.["recurringEventId"] === eventId,
            );
            expect(instances).toHaveLength(2);

            expect(await write(calendarId, "gcal_event_delete", { eventId })).toMatchObject({
              deleted: true,
            });
            deleted = true;
          },
          async () => {
            if (!deleted) await deleteIfPresent(calendarId, eventId);
          },
        );
      }),
    LIVE_TEST_TIMEOUT_MS,
  );
});
