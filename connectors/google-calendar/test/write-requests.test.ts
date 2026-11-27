import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type CapturedTools,
  captureStandaloneTools,
  captureTools,
  type FetchStub,
  type RecordedRequest,
  type StubReply,
  stubFetch,
  withEnv,
} from "../../../scripts/connector-tool-harness.ts";
import { resetConnectorModeForTests, setConnectorMode } from "../../../shared/connector-mode.ts";
import { registerGoogleCalendarTools } from "../src/tools.ts";

const API = "https://www.googleapis.com/calendar/v3";
const FULL_SCOPE = "https://www.googleapis.com/auth/calendar";
const READONLY_SCOPE = "https://www.googleapis.com/auth/calendar.readonly";
const TOKEN = "ya29.SECRET-calendar-token";

const READS = ["gcal_calendar_list", "gcal_event_get", "gcal_event_list"];
const WRITES = ["gcal_event_create", "gcal_event_delete", "gcal_event_update"];

const START = { dateTime: "2026-12-01T10:00:00+02:00", timeZone: "Europe/Berlin" };
const END = { dateTime: "2026-12-01T11:00:00+02:00", timeZone: "Europe/Berlin" };
const TIMED = { summary: "Planning", start: START, end: END };

const NO_UPDATE =
  "gcal_event_update needs at least one of summary, description, location, start and end, attendees, recurrence";
const TOGETHER = "start and end must be given together";
const SAME_KIND =
  "start and end must be the same kind: both dateTime (a timed event) or both date (an all-day event)";
const END_AFTER = "end.dateTime must be after start.dateTime";
const END_DATE_AFTER =
  "end.date must be after start.date: Google's end date is exclusive, so a one-day event on 2026-12-01 ends on 2026-12-02";
const RECURRING_ZONE =
  "a recurring timed event needs start.timeZone and end.timeZone (an IANA name such as Europe/Berlin): Google expands the recurrence in that zone";

let http: FetchStub | undefined;

function serve(reply: StubReply | ((req: RecordedRequest) => StubReply | undefined)): FetchStub {
  http?.restore();
  http = stubFetch(reply);
  return http;
}

function log(stub: FetchStub): string[] {
  return stub.calls.map((c) => `${c.method} ${c.url}`);
}

/** The tools a gateway registers for a token holding `scopes`. */
async function gatewayTools(scopes: string | undefined): Promise<CapturedTools> {
  return await withEnv({ GOOGLE_OAUTH_SCOPES: scopes }, () =>
    captureTools(registerGoogleCalendarTools),
  );
}

beforeEach(() => {
  resetConnectorModeForTests();
});

afterEach(() => {
  http?.restore();
  http = undefined;
  resetConnectorModeForTests();
});

describe("google calendar writes are listed only for a token that can write", () => {
  beforeEach(() => {
    setConnectorMode("gateway");
  });

  it("hides every write when GOOGLE_OAUTH_SCOPES is unset or read-only", async () => {
    expect((await gatewayTools(undefined)).names()).toEqual(READS);
    expect((await gatewayTools(READONLY_SCOPE)).names()).toEqual(READS);
  });

  it("lists the three writes beside the reads for the calendar scope", async () => {
    expect((await gatewayTools(`${READONLY_SCOPE} ${FULL_SCOPE}`)).names()).toEqual(
      [...READS, ...WRITES].sort((a, b) => a.localeCompare(b)),
    );
  });
});

describe("google calendar write requests (gateway mode)", () => {
  let tools: CapturedTools;

  beforeEach(async () => {
    setConnectorMode("gateway");
    tools = await gatewayTools(FULL_SCOPE);
  });

  /** Call `name` with the token set; return the one request it made. */
  async function request(
    name: string,
    args: Record<string, unknown>,
    reply: StubReply = '{"id":"evt1"}',
  ): Promise<RecordedRequest> {
    const stub = serve(reply);
    await withEnv({ GOOGLE_OAUTH_ACCESS_TOKEN: TOKEN }, async () => {
      await tools.call(name, args);
    });
    return stub.only;
  }

  /** Call `name` and expect it to throw `message` before any request. */
  async function refusedBeforeRequest(
    name: string,
    args: Record<string, unknown>,
    message: string,
  ): Promise<void> {
    const stub = serve("{}");
    await withEnv({ GOOGLE_OAUTH_ACCESS_TOKEN: TOKEN }, async () => {
      await expect(tools.call(name, args)).rejects.toThrow(message);
    });
    expect(stub.calls).toEqual([]);
  }

  describe("gcal_event_create", () => {
    it("POSTs the event to the primary calendar, telling nobody by default", async () => {
      const req = await request("gcal_event_create", TIMED);
      expect(`${req.method} ${req.url}`).toBe(
        `POST ${API}/calendars/primary/events?sendUpdates=none`,
      );
      expect(JSON.parse(req.body ?? "null")).toEqual(TIMED);
      expect(req.headers["authorization"]).toBe(`Bearer ${TOKEN}`);
      expect(req.headers["content-type"]).toBe("application/json");
      expect(req.redirect).toBe("manual");
      expect(req.url).not.toContain("conferenceDataVersion");
    });

    it("sends every optional field it is given, attendees as {email}, to an encoded calendar", async () => {
      const req = await request("gcal_event_create", {
        ...TIMED,
        calendarId: "team/x@group.calendar.google.com",
        description: "Agenda",
        location: "Room 4",
        attendees: ["ada@example.com", "grace@example.org"],
        recurrence: ["RRULE:FREQ=WEEKLY;COUNT=4", "EXDATE:20261208T080000Z"],
        sendUpdates: "all",
      });
      expect(req.url).toBe(
        `${API}/calendars/team%2Fx%40group.calendar.google.com/events?sendUpdates=all`,
      );
      expect(JSON.parse(req.body ?? "null")).toEqual({
        summary: "Planning",
        description: "Agenda",
        location: "Room 4",
        start: START,
        end: END,
        attendees: [{ email: "ada@example.com" }, { email: "grace@example.org" }],
        recurrence: ["RRULE:FREQ=WEEKLY;COUNT=4", "EXDATE:20261208T080000Z"],
      });
    });

    it("sends an all-day event as dates, and a timed one without a zone as given", async () => {
      const allDay = await request("gcal_event_create", {
        summary: "Offsite",
        start: { date: "2026-12-01" },
        end: { date: "2026-12-03" },
        sendUpdates: "externalOnly",
      });
      expect(allDay.url).toEndWith("?sendUpdates=externalOnly");
      expect(JSON.parse(allDay.body ?? "null")).toEqual({
        summary: "Offsite",
        start: { date: "2026-12-01" },
        end: { date: "2026-12-03" },
      });
      const zoneless = await request("gcal_event_create", {
        summary: "Call",
        start: { dateTime: "2026-12-01T10:00:00Z" },
        end: { dateTime: "2026-12-01T10:30:00Z" },
      });
      expect(JSON.parse(zoneless.body ?? "null")).toEqual({
        summary: "Call",
        start: { dateTime: "2026-12-01T10:00:00Z" },
        end: { dateTime: "2026-12-01T10:30:00Z" },
      });
    });

    it("refuses a malformed time at the schema", async () => {
      for (const [start, why] of [
        [{ dateTime: "2026-12-01T10:00:00" }, "Invalid ISO datetime"],
        [{ dateTime: "tomorrow" }, "Invalid ISO datetime"],
        [{ date: "2026-13-01" }, "Invalid ISO date"],
        [{ date: "2026-12-01T00:00:00Z" }, "Invalid ISO date"],
        [
          { dateTime: "2026-12-01T10:00:00Z", date: "2026-12-01" },
          "give exactly one of dateTime (a timed event) or date (an all-day event)",
        ],
        [{}, "give exactly one of dateTime (a timed event) or date (an all-day event)"],
        [
          { date: "2026-12-01", timeZone: "Europe/Berlin" },
          "timeZone goes with dateTime, not with an all-day date",
        ],
        [
          { dateTime: "2026-12-01T10:00:00Z", timeZone: "Mars/Olympus" },
          "timeZone must be an IANA time zone name such as Europe/Berlin",
        ],
        [
          { dateTime: "2026-12-01T10:00:00Z", timeZone: "+02:00" },
          "timeZone must be an IANA time zone name such as Europe/Berlin",
        ],
        [{ dateTime: "2026-12-01T10:00:00Z", extra: 1 }, "Unrecognized key"],
      ] as const) {
        await refusedBeforeRequest("gcal_event_create", { ...TIMED, start }, why);
      }
    });

    it("refuses an end that is not after the start, or a mix of kinds", async () => {
      await refusedBeforeRequest("gcal_event_create", { ...TIMED, end: START }, END_AFTER);
      await refusedBeforeRequest(
        "gcal_event_create",
        { ...TIMED, start: END, end: START },
        END_AFTER,
      );
      await refusedBeforeRequest(
        "gcal_event_create",
        { summary: "Offsite", start: { date: "2026-12-01" }, end: { date: "2026-12-01" } },
        END_DATE_AFTER,
      );
      await refusedBeforeRequest(
        "gcal_event_create",
        { summary: "Offsite", start: { date: "2026-12-01" }, end: END },
        SAME_KIND,
      );
    });

    it("refuses a recurrence line that is not RRULE, EXRULE, RDATE or EXDATE, or holds a line break", async () => {
      const prefix =
        "must start with RRULE:, EXRULE:, RDATE: or EXDATE: and hold no control character";
      for (const [line, why] of [
        ["FREQ=DAILY", prefix],
        ["rrule:FREQ=DAILY", prefix],
        ["DTSTART:20261201T100000Z", prefix],
        ["ATTENDEE:mailto:x@example.com", prefix],
        ["RRULE:", prefix],
        ["EXDATE;TZID=Europe/Berlin:20261208T100000", prefix],
        ["RRULE:FREQ=DAILY\r\nATTENDEE:mailto:x@example.com", "must not contain a line break"],
        ["RRULE:FREQ=DAILY\nX", "must not contain a line break"],
        ["RRULE:FREQ=DAILY\tX", prefix],
      ] as const) {
        await refusedBeforeRequest("gcal_event_create", { ...TIMED, recurrence: [line] }, why);
      }
      await refusedBeforeRequest(
        "gcal_event_create",
        { ...TIMED, recurrence: Array.from({ length: 11 }, () => "RRULE:FREQ=DAILY") },
        "Too big",
      );
    });

    it("refuses a recurring timed event without a time zone on both ends", async () => {
      await refusedBeforeRequest(
        "gcal_event_create",
        {
          summary: "Standup",
          start: { dateTime: "2026-12-01T09:00:00Z" },
          end: { dateTime: "2026-12-01T09:15:00Z", timeZone: "UTC" },
          recurrence: ["RRULE:FREQ=DAILY"],
        },
        RECURRING_ZONE,
      );
    });

    it("refuses bad attendees, a bad calendar id and an unknown sendUpdates at the schema", async () => {
      for (const [args, why] of [
        [{ attendees: ["not-an-email"] }, "Invalid email"],
        [{ attendees: ["Ada <ada@example.com>"] }, "Invalid email"],
        [
          { attendees: ["ada@example.com", "ADA@example.com"] },
          "attendees must not name the same email twice",
        ],
        [
          { attendees: Array.from({ length: 101 }, (_, i) => `p${String(i)}@example.com`) },
          "Too big",
        ],
        [{ calendarId: ".." }, "must not be a dot segment"],
        [{ calendarId: "." }, "must not be a dot segment"],
        [{ sendUpdates: "everyone" }, "Invalid option"],
        [{ summary: "" }, "Too small"],
        [{ summary: "x".repeat(1025) }, "Too big"],
        [{ location: "x".repeat(1025) }, "Too big"],
        [{ description: "x".repeat(8193) }, "Too big"],
      ] as const) {
        await refusedBeforeRequest("gcal_event_create", { ...TIMED, ...args }, why);
      }
    });

    it("never forwards a field it does not define, such as conferenceData", async () => {
      const req = await request("gcal_event_create", {
        ...TIMED,
        conferenceData: { createRequest: { requestId: "r" } },
        visibility: "public",
      });
      expect(JSON.parse(req.body ?? "null")).toEqual(TIMED);
      expect(req.url).toBe(`${API}/calendars/primary/events?sendUpdates=none`);
    });
  });

  describe("gcal_event_update", () => {
    it("PATCHes only the fields it is given, at the encoded event, telling nobody by default", async () => {
      const req = await request("gcal_event_update", {
        eventId: "abc_20261201T080000Z",
        summary: "Renamed",
      });
      expect(`${req.method} ${req.url}`).toBe(
        `PATCH ${API}/calendars/primary/events/abc_20261201T080000Z?sendUpdates=none`,
      );
      expect(JSON.parse(req.body ?? "null")).toEqual({ summary: "Renamed" });
      expect(req.redirect).toBe("manual");
    });

    it("clears the other kind of time when it moves an event, and replaces the guest list", async () => {
      const req = await request("gcal_event_update", {
        calendarId: "c@x/..",
        eventId: "..%2f",
        start: { date: "2026-12-01" },
        end: { date: "2026-12-02" },
        attendees: [],
        description: "",
        sendUpdates: "all",
      });
      expect(req.url).toBe(`${API}/calendars/c%40x%2F../events/..%252f?sendUpdates=all`);
      expect(JSON.parse(req.body ?? "null")).toEqual({
        description: "",
        start: { date: "2026-12-01", dateTime: null },
        end: { date: "2026-12-02", dateTime: null },
        attendees: [],
      });
      const timed = await request("gcal_event_update", {
        eventId: "e1",
        start: START,
        end: { dateTime: "2026-12-01T11:00:00+02:00" },
        attendees: ["ada@example.com"],
        location: "Room 5",
      });
      expect(JSON.parse(timed.body ?? "null")).toEqual({
        location: "Room 5",
        start: { ...START, date: null },
        end: { dateTime: "2026-12-01T11:00:00+02:00", date: null },
        attendees: [{ email: "ada@example.com" }],
      });
      const rule = await request("gcal_event_update", {
        eventId: "series1",
        recurrence: ["RRULE:FREQ=DAILY;COUNT=2"],
      });
      expect(JSON.parse(rule.body ?? "null")).toEqual({ recurrence: ["RRULE:FREQ=DAILY;COUNT=2"] });
    });

    it("refuses moving a recurring series to times without a zone on both ends", async () => {
      await refusedBeforeRequest(
        "gcal_event_update",
        {
          eventId: "series1",
          start: START,
          end: { dateTime: "2026-12-01T11:00:00+02:00" },
          recurrence: ["RRULE:FREQ=DAILY;COUNT=2"],
        },
        RECURRING_ZONE,
      );
    });

    it("refuses an update that changes nothing, before any request", async () => {
      await refusedBeforeRequest("gcal_event_update", { eventId: "e1" }, NO_UPDATE);
      await refusedBeforeRequest(
        "gcal_event_update",
        { eventId: "e1", calendarId: "team@x", sendUpdates: "all" },
        NO_UPDATE,
      );
    });

    it("refuses a start without an end, an end without a start, and an inverted range", async () => {
      await refusedBeforeRequest("gcal_event_update", { eventId: "e1", start: START }, TOGETHER);
      await refusedBeforeRequest("gcal_event_update", { eventId: "e1", end: END }, TOGETHER);
      await refusedBeforeRequest(
        "gcal_event_update",
        { eventId: "e1", start: END, end: START },
        END_AFTER,
      );
      await refusedBeforeRequest(
        "gcal_event_update",
        { eventId: "e1", start: START, end: { date: "2026-12-02" } },
        SAME_KIND,
      );
    });

    it("refuses bad ids and bad fields at the schema", async () => {
      for (const [args, why] of [
        [{ eventId: "", summary: "x" }, "Too small"],
        [{ eventId: "..", summary: "x" }, "must not be a dot segment"],
        [{ eventId: "e1", calendarId: "..", summary: "x" }, "must not be a dot segment"],
        [{ eventId: "x".repeat(1025), summary: "x" }, "Too big"],
        [{ eventId: "e1", attendees: ["nope"] }, "Invalid email"],
        [
          { eventId: "e1", recurrence: ["RRULE:FREQ=DAILY\r\nX:y"] },
          "must not contain a line break",
        ],
        [{ eventId: "e1", recurrence: [] }, "Too small"],
        [{ eventId: "e1", summary: "" }, "Too small"],
      ] as const) {
        await refusedBeforeRequest("gcal_event_update", args, why);
      }
    });
  });

  describe("gcal_event_delete", () => {
    it("DELETEs the encoded event, telling nobody by default, and reports the deletion", async () => {
      const stub = serve({ status: 204, body: "" });
      let answer: unknown;
      await withEnv({ GOOGLE_OAUTH_ACCESS_TOKEN: TOKEN }, async () => {
        answer = await tools.callJson("gcal_event_delete", { eventId: "e 1/2" });
      });
      expect(log(stub)).toEqual([
        `DELETE ${API}/calendars/primary/events/e%201%2F2?sendUpdates=none`,
      ]);
      expect(stub.only.redirect).toBe("manual");
      expect(answer).toEqual({ deleted: true, calendarId: "primary", eventId: "e 1/2" });
    });

    it("carries sendUpdates and an encoded calendar id", async () => {
      const req = await request(
        "gcal_event_delete",
        { calendarId: "team@group.calendar.google.com", eventId: "e1", sendUpdates: "all" },
        { status: 204, body: "" },
      );
      expect(req.url).toBe(
        `${API}/calendars/team%40group.calendar.google.com/events/e1?sendUpdates=all`,
      );
    });

    it("reports a 410 as already deleted, never as a deletion", async () => {
      serve({ status: 410, body: '{"error":{"code":410,"message":"Resource has been deleted"}}' });
      let answer: unknown;
      await withEnv({ GOOGLE_OAUTH_ACCESS_TOKEN: TOKEN }, async () => {
        answer = await tools.callJson("gcal_event_delete", { eventId: "e1" });
      });
      expect(answer).toEqual({
        deleted: false,
        alreadyDeleted: true,
        calendarId: "primary",
        eventId: "e1",
        message:
          "Google Calendar answered 410 Gone: the event was already deleted, so this call deleted nothing",
      });
    });

    it("surfaces any other failure with its status and a bounded snippet", async () => {
      serve({ status: 404, body: `{"error":"Not Found"}${"x".repeat(1000)}` });
      await withEnv({ GOOGLE_OAUTH_ACCESS_TOKEN: TOKEN }, async () => {
        const err = await tools
          .call("gcal_event_delete", { eventId: "e1" })
          .catch((e: unknown) => e);
        expect(err).toBeInstanceOf(Error);
        const message = (err as Error).message;
        expect(message).toStartWith('Google Calendar API 404: {"error":"Not Found"}');
        expect(message.length).toBeLessThan(400);
      });
    });

    it("refuses bad ids at the schema", async () => {
      await refusedBeforeRequest(
        "gcal_event_delete",
        { eventId: ".." },
        "must not be a dot segment",
      );
      await refusedBeforeRequest(
        "gcal_event_delete",
        { eventId: "e1", calendarId: "." },
        "must not be a dot segment",
      );
      await refusedBeforeRequest(
        "gcal_event_delete",
        { eventId: "e1", sendUpdates: "nobody" },
        "Invalid option",
      );
    });
  });

  describe("every write", () => {
    const CALLS: readonly (readonly [string, string, Record<string, unknown>])[] = [
      ["gcal_event_create", "POST", TIMED],
      ["gcal_event_update", "PATCH", { eventId: "e1", summary: "x" }],
      ["gcal_event_delete", "DELETE", { eventId: "e1" }],
    ];

    it("refuses a redirect rather than follow it with the token", async () => {
      for (const [name, method, args] of CALLS) {
        const stub = serve({ status: 307, headers: { Location: "https://evil.example/steal" } });
        await withEnv({ GOOGLE_OAUTH_ACCESS_TOKEN: TOKEN }, async () => {
          await expect(tools.call(name, args)).rejects.toThrow(
            `Google Calendar API answered a ${method} with a redirect (307); the write may or may not have been applied`,
          );
        });
        expect(stub.calls.map((c) => new URL(c.url).host)).toEqual(["www.googleapis.com"]);
      }
    });

    it("quotes Google's status and body, and never the token", async () => {
      for (const [name, , args] of CALLS) {
        serve({ status: 403, body: '{"error":{"message":"Insufficient Permission"}}' });
        await withEnv({ GOOGLE_OAUTH_ACCESS_TOKEN: TOKEN }, async () => {
          const err = await tools.call(name, args).catch((e: unknown) => e);
          expect(err).toBeInstanceOf(Error);
          const message = (err as Error).message;
          expect(message).toBe(
            'Google Calendar API 403: {"error":{"message":"Insufficient Permission"}}',
          );
          expect(message).not.toContain(TOKEN);
        });
      }
    });

    it("refuses without a token, naming the variable, before any request", async () => {
      for (const [name, , args] of CALLS) {
        const stub = serve("{}");
        await withEnv({ GOOGLE_OAUTH_ACCESS_TOKEN: undefined }, async () => {
          await expect(tools.call(name, args)).rejects.toThrow(
            "GOOGLE_OAUTH_ACCESS_TOKEN is not set",
          );
        });
        expect(stub.calls).toEqual([]);
      }
    });
  });
});

describe("google calendar writes (standalone mode)", () => {
  let auditDir: string;
  let auditLog: string;

  beforeEach(() => {
    setConnectorMode("standalone");
    auditDir = mkdtempSync(join(tmpdir(), "nimbus-gcal-audit-"));
    auditLog = join(auditDir, "audit.jsonl");
  });

  afterEach(() => {
    rmSync(auditDir, { recursive: true, force: true });
  });

  async function standalone(): Promise<ReturnType<typeof captureStandaloneTools>> {
    let cap: ReturnType<typeof captureStandaloneTools> | undefined;
    await withEnv(
      {
        GOOGLE_OAUTH_SCOPES: FULL_SCOPE,
        NIMBUS_MCP_GOOGLE_CALENDAR_WRITE_SCOPE: "calendar:primary",
        NIMBUS_MCP_AUDIT_LOG: auditLog,
        NIMBUS_MCP_WRITE_BUDGET: undefined,
      },
      () => {
        cap = captureStandaloneTools(registerGoogleCalendarTools, { elicitation: true });
      },
    );
    if (cap === undefined) throw new Error("registration did not run");
    return cap;
  }

  function audited(outcome: string): Record<string, unknown> | undefined {
    return readFileSync(auditLog, "utf8")
      .trim()
      .split("\n")
      .map(
        (l) =>
          (JSON.parse(l) as { entry: { outcome: string; detail: Record<string, unknown> } }).entry,
      )
      .find((e) => e.outcome === outcome)?.detail;
  }

  /** Call `name` and expect `{ ok: false, error }` with no prompt and no request. */
  async function refusedBeforePrompt(
    name: string,
    args: Record<string, unknown>,
    error: string,
  ): Promise<void> {
    const cap = await standalone();
    const stub = serve("{}");
    await withEnv({ GOOGLE_OAUTH_ACCESS_TOKEN: TOKEN }, async () => {
      expect(await cap.tools.callJson(name, args)).toEqual({ ok: false, error });
    });
    expect(cap.prompts).toEqual([]);
    expect(stub.calls).toEqual([]);
  }

  it("refuses an update with nothing to change before the prompt", async () => {
    await refusedBeforePrompt("gcal_event_update", { eventId: "e1" }, NO_UPDATE);
  });

  it("refuses an update moving only one end before the prompt", async () => {
    await refusedBeforePrompt("gcal_event_update", { eventId: "e1", start: START }, TOGETHER);
  });

  it("refuses an inverted or mixed range, and a zoneless recurrence, before the prompt", async () => {
    await refusedBeforePrompt("gcal_event_create", { ...TIMED, end: START }, END_AFTER);
    await refusedBeforePrompt(
      "gcal_event_create",
      { summary: "x", start: { date: "2026-12-01" }, end: END },
      SAME_KIND,
    );
    await refusedBeforePrompt(
      "gcal_event_create",
      {
        summary: "Standup",
        start: { dateTime: "2026-12-01T09:00:00Z" },
        end: { dateTime: "2026-12-01T09:15:00Z" },
        recurrence: ["RRULE:FREQ=DAILY"],
      },
      RECURRING_ZONE,
    );
  });

  it("asks a human about google_calendar.event.create, and sends the event once approved", async () => {
    const cap = await standalone();
    const stub = serve('{"id":"evt1"}');
    await withEnv({ GOOGLE_OAUTH_ACCESS_TOKEN: TOKEN }, async () => {
      expect(await cap.tools.callJson("gcal_event_create", TIMED)).toEqual({ id: "evt1" });
    });
    expect(cap.prompts.map((p) => p.split("\n")[0])).toEqual([
      "Nimbus is about to perform google_calendar.event.create with:",
    ]);
    expect(log(stub)).toEqual([`POST ${API}/calendars/primary/events?sendUpdates=none`]);
  });

  it("update captures the event BEFORE the PATCH", async () => {
    const cap = await standalone();
    const event = JSON.stringify({
      id: "e1",
      status: "confirmed",
      summary: "Old",
      start: START,
      end: END,
      attendees: [{ email: "ada@example.com", responseStatus: "accepted" }],
      htmlLink: "https://calendar.google.com/x",
    });
    const stub = serve((req) => (req.method === "GET" ? event : '{"id":"e1"}'));
    await withEnv({ GOOGLE_OAUTH_ACCESS_TOKEN: TOKEN }, async () => {
      await cap.tools.call("gcal_event_update", { eventId: "e1", summary: "New" });
    });
    expect(log(stub)).toEqual([
      `GET ${API}/calendars/primary/events/e1`,
      `PATCH ${API}/calendars/primary/events/e1?sendUpdates=none`,
    ]);
    expect(audited("executed")?.["preState"]).toEqual({
      id: "e1",
      status: "confirmed",
      summary: "Old",
      start: START,
      end: END,
      attendees: [{ email: "ada@example.com", responseStatus: "accepted" }],
    });
  });

  it("delete captures the event BEFORE the DELETE", async () => {
    const cap = await standalone();
    const event = JSON.stringify({
      id: "e1",
      summary: "Gone soon",
      start: START,
      end: END,
      recurrence: ["RRULE:FREQ=DAILY"],
    });
    const stub = serve((req) => (req.method === "GET" ? event : { status: 204, body: "" }));
    await withEnv({ GOOGLE_OAUTH_ACCESS_TOKEN: TOKEN }, async () => {
      expect(await cap.tools.callJson("gcal_event_delete", { eventId: "e1" })).toEqual({
        deleted: true,
        calendarId: "primary",
        eventId: "e1",
      });
    });
    expect(log(stub)).toEqual([
      `GET ${API}/calendars/primary/events/e1`,
      `DELETE ${API}/calendars/primary/events/e1?sendUpdates=none`,
    ]);
    expect(audited("executed")?.["preState"]).toEqual({
      id: "e1",
      summary: "Gone soon",
      start: START,
      end: END,
      recurrence: ["RRULE:FREQ=DAILY"],
    });
  });

  it("records an unreadable event as unresolved rather than failing the capture", async () => {
    const cap = await standalone();
    serve((req) =>
      req.method === "GET" ? { status: 404, body: "nope" } : { status: 410, body: "" },
    );
    await withEnv({ GOOGLE_OAUTH_ACCESS_TOKEN: TOKEN }, async () => {
      await cap.tools.call("gcal_event_delete", { eventId: "e1" });
    });
    expect(audited("executed")?.["preState"]).toEqual({ resolved: false, status: 404 });
  });
});
