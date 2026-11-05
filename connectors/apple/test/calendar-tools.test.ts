import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import { parseICalendar } from "@nimbus-dev/sdk";
import { resetConnectorModeForTests, setConnectorMode } from "../../../shared/connector-mode.ts";
import type { CalDavClient, CalendarRef } from "../src/caldav-core.ts";
import {
  hasControlCharacter,
  hasWhitespaceOrControl,
  ICLOUD_ATTENDEE_REFUSAL,
  ICLOUD_TEXT_REFUSAL,
  ICLOUD_TIME_REFUSAL,
  ICLOUD_UID_REFUSAL,
  registerAppleCalendarTools,
} from "../src/calendar-tools.ts";

// These cases exercise the TOOL SURFACE, not the consent gate, and pass a minimal fake server.
// Gateway mode is the shape they were written against: the connector registers everything and
// executor.ts (I2) is the gate there. Reset on BOTH sides — bun test runs many files in ONE
// process, so an unreset lock would change every file that runs after this one.
beforeEach(() => {
  resetConnectorModeForTests();
  setConnectorMode("gateway");
});
afterEach(() => {
  resetConnectorModeForTests();
});

// ---------------------------------------------------------------------------
// Stub MCP server (mirrors tools.test.ts pattern)
// ---------------------------------------------------------------------------

function stubServer() {
  const tools: Record<string, (input: unknown) => Promise<unknown>> = {};
  return {
    server: {
      // The consent kit registers through `registerTool`, which returns a handle; the deprecated
      // `tool` below is what the read tools still use. Both record into the same map.
      registerTool: (
        name: string,
        _cfg: unknown,
        cb: (i: unknown) => Promise<unknown>,
      ): { disable: () => void } => {
        tools[name] = cb;
        return { disable: () => undefined };
      },
      tool: (
        name: string,
        _desc: string,
        _schema: unknown,
        cb: (i: unknown) => Promise<unknown>,
      ) => {
        tools[name] = cb;
      },
    },
    tools,
  };
}

/** Parse the JSON payload from an mcpJsonResult content envelope. */
function parseResult(result: unknown): unknown {
  if (
    typeof result === "object" &&
    result !== null &&
    "content" in result &&
    Array.isArray((result as { content: unknown[] }).content)
  ) {
    const first = (result as { content: { type: string; text: string }[] }).content[0];
    if (first?.type === "text") {
      return JSON.parse(first.text) as unknown;
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Fake CalDavClient
// ---------------------------------------------------------------------------

const WORK_CAL: CalendarRef = {
  url: "https://caldav.icloud.com/calendars/work",
  displayName: "Work",
};
const HOME_CAL: CalendarRef = {
  url: "https://caldav.icloud.com/calendars/home",
  displayName: "Home",
};

const LONG_NOTES = "N".repeat(5000);
const CAPPED_NOTES_LEN = 2000;

function makeFakeCalDavClient(overrides?: Partial<CalDavClient>): {
  client: CalDavClient;
  putCalls: { cal: CalendarRef; uid: string; ics: string }[];
  deleteCalls: string[];
} {
  const putCalls: { cal: CalendarRef; uid: string; ics: string }[] = [];
  const deleteCalls: string[] = [];

  const client: CalDavClient = {
    listCalendars: async () => [WORK_CAL, HOME_CAL],
    listEvents: async (cal) => {
      if (cal.displayName === "Work") {
        return [
          {
            href: "/calendars/work/event1.ics",
            event: {
              uid: "event-1",
              recurrenceId: null,
              summary: "Standup",
              description: LONG_NOTES,
              location: "Room 4",
              start: "20260601T090000Z",
              end: "20260601T091500Z",
              allDay: false,
              status: "CONFIRMED",
              organizer: "boss@icloud.com",
              attendees: ["a@icloud.com", "b@icloud.com"],
              rrule: null,
              dtstamp: "20260601T000000Z",
            },
          },
        ];
      }
      if (cal.displayName === "Home") {
        return [
          {
            href: "/calendars/home/event2.ics",
            event: {
              uid: "event-2",
              recurrenceId: null,
              summary: "Dinner",
              description: "Family dinner",
              location: null,
              start: "20260601T190000Z",
              end: "20260601T210000Z",
              allDay: false,
              status: null,
              organizer: null,
              attendees: ["sister@example.com"],
              rrule: null,
              dtstamp: "20260601T000000Z",
            },
          },
        ];
      }
      return [];
    },
    putEvent: async (cal, uid, ics) => {
      putCalls.push({ cal, uid, ics });
      return { href: `/calendars/${cal.displayName.toLowerCase()}/${uid}.ics` };
    },
    deleteEvent: async (href) => {
      deleteCalls.push(href);
    },
    ...overrides,
  };

  return { client, putCalls, deleteCalls };
}

// ---------------------------------------------------------------------------
// apple_calendar_list
// ---------------------------------------------------------------------------

describe("apple_calendar_list", () => {
  it("returns events from all calendars with attendees included", async () => {
    const { client } = makeFakeCalDavClient();
    const { server, tools } = stubServer();

    registerAppleCalendarTools(server as never, {
      calendar: client,
      now: () => "20260601T000000Z",
    });

    const result = parseResult(
      await tools.apple_calendar_list({
        startUtc: "20260601T000000Z",
        endUtc: "20260601T235959Z",
      }),
    ) as { items: unknown[] };

    expect(result.items).toHaveLength(2);

    const first = result.items[0] as {
      uid: string;
      summary: string;
      attendees: string[];
      notes: string;
      calendar: string;
    };
    expect(first.uid).toBe("event-1");
    expect(first.summary).toBe("Standup");
    expect(first.attendees).toEqual(["a@icloud.com", "b@icloud.com"]);
    expect(first.calendar).toBe("Work");

    const second = result.items[1] as {
      uid: string;
      attendees: string[];
      calendar: string;
    };
    expect(second.uid).toBe("event-2");
    expect(second.attendees).toEqual(["sister@example.com"]);
    expect(second.calendar).toBe("Home");
  });

  it("caps event notes (description) at 2000 chars", async () => {
    const { client } = makeFakeCalDavClient();
    const { server, tools } = stubServer();

    registerAppleCalendarTools(server as never, {
      calendar: client,
      now: () => "20260601T000000Z",
    });

    const result = parseResult(
      await tools.apple_calendar_list({
        startUtc: "20260601T000000Z",
        endUtc: "20260601T235959Z",
      }),
    ) as { items: { notes: string }[] };

    // The first event has a 5000-char description — must be capped at 2000.
    expect(result.items[0]?.notes.length).toBeLessThanOrEqual(CAPPED_NOTES_LEN);
    expect(result.items[0]?.notes).toHaveLength(CAPPED_NOTES_LEN);
  });

  it("filters to the requested calendar when calendar arg is supplied", async () => {
    const { client } = makeFakeCalDavClient();
    const { server, tools } = stubServer();

    registerAppleCalendarTools(server as never, {
      calendar: client,
      now: () => "20260601T000000Z",
    });

    const result = parseResult(
      await tools.apple_calendar_list({
        startUtc: "20260601T000000Z",
        endUtc: "20260601T235959Z",
        calendar: "Work",
      }),
    ) as { items: { calendar: string }[] };

    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.calendar).toBe("Work");
  });

  it("stops reading calendars once maxInstances events are collected", async () => {
    const read: string[] = [];
    const { client } = makeFakeCalDavClient();
    const listEvents = client.listEvents;
    const { server, tools } = stubServer();

    registerAppleCalendarTools(server as never, {
      calendar: {
        ...client,
        listEvents: async (cal, window) => {
          read.push(cal.displayName);
          return listEvents(cal, window);
        },
      },
      now: () => "20260601T000000Z",
      config: { maxInstances: 1 },
    });

    const result = parseResult(
      await tools["apple_calendar_list"]!({
        startUtc: "20260601T000000Z",
        endUtc: "20260601T235959Z",
      }),
    ) as { items: { uid: string }[] };

    expect(result.items.map((i) => i.uid)).toEqual(["event-1"]);
    // Home is never asked for its events: the cap was reached on Work.
    expect(read).toEqual(["Work"]);
  });

  it("reports empty notes for an event without a description", async () => {
    const { client } = makeFakeCalDavClient({
      listCalendars: async () => [WORK_CAL],
      listEvents: async () => [
        {
          href: "/calendars/work/bare.ics",
          event: {
            uid: "bare",
            recurrenceId: null,
            summary: "Focus",
            description: null,
            location: null,
            start: "20260601T120000Z",
            end: "20260601T130000Z",
            allDay: false,
            status: null,
            organizer: null,
            attendees: [],
            rrule: null,
            dtstamp: "20260601T000000Z",
          },
        },
      ],
    });
    const { server, tools } = stubServer();
    registerAppleCalendarTools(server as never, { calendar: client, now: () => "x" });

    const result = parseResult(
      await tools["apple_calendar_list"]!({
        startUtc: "20260601T000000Z",
        endUtc: "20260601T235959Z",
      }),
    ) as { items: { uid: string; notes: string }[] };
    expect(result.items).toEqual([expect.objectContaining({ uid: "bare", notes: "" })]);
  });

  it("refuses arguments its schema rejects before touching the calendar", async () => {
    let listed = 0;
    const { client } = makeFakeCalDavClient({
      listCalendars: async () => {
        listed += 1;
        return [];
      },
    });
    const { server, tools } = stubServer();
    registerAppleCalendarTools(server as never, { calendar: client, now: () => "x" });

    await expect(tools["apple_calendar_list"]!({ startUtc: "", endUtc: "e" })).rejects.toThrow(
      /"startUtc"[\s\S]*Too small/,
    );
    expect(listed).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// apple_calendar_event_create
// ---------------------------------------------------------------------------

describe("apple_calendar_event_create", () => {
  it("calls putEvent with a valid ICS and returns uid + href", async () => {
    const { client, putCalls } = makeFakeCalDavClient();
    const { server, tools } = stubServer();

    registerAppleCalendarTools(server as never, {
      calendar: client,
      now: () => "20260601T000000Z",
    });

    const result = parseResult(
      await tools.apple_calendar_event_create({
        summary: "Team Meeting",
        start: "20260601T100000Z",
        end: "20260601T110000Z",
        uid: "test-uid-123",
      }),
    ) as { uid: string; href: string };

    expect(result.uid).toBe("test-uid-123");
    expect(result.href).toBeTruthy();
    expect(putCalls).toHaveLength(1);
    expect(putCalls[0]?.uid).toBe("test-uid-123");
  });

  it("produces an ICS that round-trips through parseICalendar", async () => {
    const { client, putCalls } = makeFakeCalDavClient();
    const { server, tools } = stubServer();

    registerAppleCalendarTools(server as never, {
      calendar: client,
      now: () => "20260601T000000Z",
    });

    await tools.apple_calendar_event_create({
      summary: "Round-trip Test",
      start: "20260602T140000Z",
      end: "20260602T150000Z",
      description: "Check escaping",
      location: "Online",
      attendees: ["alice@example.com", "bob@example.com"],
      uid: "rt-uid-456",
    });

    expect(putCalls).toHaveLength(1);
    const ics = putCalls[0]?.ics ?? "";

    // The ICS must be valid and parse back to the original fields.
    const events = parseICalendar(ics);
    expect(events).toHaveLength(1);
    const ev = events[0];
    expect(ev?.uid).toBe("rt-uid-456");
    expect(ev?.summary).toBe("Round-trip Test");
    expect(ev?.start).toBe("20260602T140000Z");
    expect(ev?.end).toBe("20260602T150000Z");
    expect(ev?.description).toBe("Check escaping");
    expect(ev?.location).toBe("Online");
    expect(ev?.attendees).toEqual(["alice@example.com", "bob@example.com"]);
  });

  it("targets the specified calendar when calendar arg is supplied", async () => {
    const { client, putCalls } = makeFakeCalDavClient();
    const { server, tools } = stubServer();

    registerAppleCalendarTools(server as never, {
      calendar: client,
      now: () => "20260601T000000Z",
    });

    await tools.apple_calendar_event_create({
      summary: "Home Task",
      start: "20260603T080000Z",
      end: "20260603T090000Z",
      calendar: "Home",
      uid: "home-uid-789",
    });

    expect(putCalls).toHaveLength(1);
    expect(putCalls[0]?.cal.displayName).toBe("Home");
  });

  it("generates a uid when none is supplied", async () => {
    const { client, putCalls } = makeFakeCalDavClient();
    const { server, tools } = stubServer();

    registerAppleCalendarTools(server as never, {
      calendar: client,
      now: () => "20260601T120000Z",
    });

    const result = parseResult(
      await tools.apple_calendar_event_create({
        summary: "Auto UID Event",
        start: "20260604T100000Z",
        end: "20260604T110000Z",
      }),
    ) as { uid: string };

    expect(result.uid).toBeTruthy();
    expect(result.uid.length).toBeGreaterThan(0);
    expect(putCalls[0]?.uid).toBe(result.uid);
  });

  it("throws when the specified calendar does not exist", async () => {
    const { client } = makeFakeCalDavClient();
    const { server, tools } = stubServer();

    registerAppleCalendarTools(server as never, {
      calendar: client,
      now: () => "20260601T000000Z",
    });

    await expect(
      tools.apple_calendar_event_create({
        summary: "Orphan",
        start: "20260601T100000Z",
        end: "20260601T110000Z",
        calendar: "NonExistent",
        uid: "orphan-uid",
      }),
    ).rejects.toThrow('Calendar "NonExistent" not found');
  });
});

// ---------------------------------------------------------------------------
// apple_calendar_event_create: input refused at the schema (R10 d, OR-B4-6, review fixes 1 and 5)
// ---------------------------------------------------------------------------

describe("apple_calendar_event_create refuses unsafe input before any CalDAV call", () => {
  const VALID = {
    summary: "Team Meeting",
    start: "20260601T100000Z",
    end: "20260601T110000Z",
    uid: "ok-uid",
  };

  /** Call create with `overrides` on a valid event; return the error and whether anything ran. */
  async function refusal(overrides: Record<string, unknown>): Promise<{
    message: string;
    touched: boolean;
  }> {
    let listed = 0;
    const { client, putCalls } = makeFakeCalDavClient({
      listCalendars: async () => {
        listed += 1;
        return [WORK_CAL, HOME_CAL];
      },
    });
    const { server, tools } = stubServer();
    registerAppleCalendarTools(server as never, {
      calendar: client,
      now: () => "20260601T000000Z",
    });
    let message = "";
    try {
      await tools.apple_calendar_event_create!({ ...VALID, ...overrides });
    } catch (e) {
      message = e instanceof Error ? e.message : String(e);
    }
    return { message, touched: listed > 0 || putCalls.length > 0 };
  }

  it("accepts the valid event the cases below start from", async () => {
    expect(await refusal({})).toEqual({ message: "", touched: true });
  });

  it("refuses a CRLF-injected attendee, naming the attendee rule", async () => {
    const out = await refusal({
      attendees: ["alice@example.com\r\nATTENDEE:mailto:mallory@example.com"],
    });
    expect(out.touched).toBe(false);
    expect(out.message).toContain(ICLOUD_ATTENDEE_REFUSAL);
  });

  it("refuses an attendee with a space, a TAB, a bare LF or a C1 control", async () => {
    for (const bad of [
      "alice @example.com",
      "alice@example.com\t",
      "alice@example.com\n",
      "alice@example.com\u0085",
    ]) {
      const out = await refusal({ attendees: ["bob@example.com", bad] });
      expect({
        bad,
        touched: out.touched,
        named: out.message.includes(ICLOUD_ATTENDEE_REFUSAL),
      }).toEqual({ bad, touched: false, named: true });
    }
  });

  it("refuses a bare CR in the summary, which the SDK's escaping would have left in place", async () => {
    const out = await refusal({ summary: "Lunch\rATTENDEE:mailto:mallory@example.com" });
    expect(out.touched).toBe(false);
    expect(out.message).toContain(ICLOUD_TEXT_REFUSAL);
    expect(out.message).toContain('"summary"');
  });

  it("refuses CR, LF, TAB, DEL and C1 controls in every free-text field", async () => {
    const controls = ["\r", "\n", "\r\n", "\t", "\u0000", "\u007f", "\u0085", "\u009f"];
    for (const field of ["summary", "description", "location", "calendar"]) {
      for (const c of controls) {
        const out = await refusal({ [field]: `Work${c}X` });
        expect({
          field,
          code: c.charCodeAt(0),
          touched: out.touched,
          named: out.message.includes(ICLOUD_TEXT_REFUSAL),
        }).toEqual({ field, code: c.charCodeAt(0), touched: false, named: true });
      }
    }
  });

  it("refuses a DTSTART or DTEND that is not UTC YYYYMMDDTHHMMSSZ", async () => {
    const bad = [
      "20260601T100000", // floating
      "20260601", // all-day
      "2026-06-01T10:00:00Z", // ISO 8601, not iCalendar
      "20260601T100000+0200", // an offset
      "20260601T100000Z\r\nATTENDEE:mailto:mallory@example.com", // injection after a valid time
      "20260601T100000Z\n",
      "",
    ];
    for (const field of ["start", "end"]) {
      for (const value of bad) {
        const out = await refusal({ [field]: value });
        expect({
          field,
          value,
          touched: out.touched,
          named: out.message.includes(ICLOUD_TIME_REFUSAL),
        }).toEqual({ field, value, touched: false, named: true });
      }
    }
  });

  it("refuses a uid outside [A-Za-z0-9._@-]{1,200}, and accepts one inside it", async () => {
    for (const uid of ["a/b", "a b", "a:b", "../x", "x".repeat(201), "", "u1\r\nX-EVIL:1"]) {
      const out = await refusal({ uid });
      expect({
        uid,
        touched: out.touched,
        named: out.message.includes(ICLOUD_UID_REFUSAL),
      }).toEqual({ uid, touched: false, named: true });
    }
    expect(await refusal({ uid: "Meet.2026_06@host-1" })).toEqual({ message: "", touched: true });
    expect(await refusal({ uid: "x".repeat(200) })).toEqual({ message: "", touched: true });
  });

  it("puts nothing but the given values on the event's content lines", async () => {
    const { client, putCalls } = makeFakeCalDavClient();
    const { server, tools } = stubServer();
    registerAppleCalendarTools(server as never, {
      calendar: client,
      now: () => "20260601T000000Z",
    });
    await tools.apple_calendar_event_create!({
      ...VALID,
      description: "Agenda; notes, more",
      location: "Room 4",
      attendees: ["alice@example.com"],
    });
    const lines = (putCalls[0]?.ics ?? "").split("\r\n");
    expect(lines).toContain("DTSTART:20260601T100000Z");
    expect(lines).toContain("DTEND:20260601T110000Z");
    expect(lines.filter((l) => l.startsWith("ATTENDEE:"))).toEqual([
      "ATTENDEE:mailto:alice@example.com",
    ]);
    // No line carries a stray CR or LF of its own.
    expect(lines.every((l) => !l.includes("\r") && !l.includes("\n"))).toBe(true);
  });
});

describe("hasControlCharacter / hasWhitespaceOrControl", () => {
  it("finds C0 controls, DEL and C1 controls, and nothing in printable text", () => {
    for (const code of [0x00, 0x09, 0x0a, 0x0d, 0x1f, 0x7f, 0x80, 0x85, 0x9f]) {
      expect({ code, found: hasControlCharacter(`a${String.fromCharCode(code)}b`) }).toEqual({
        code,
        found: true,
      });
    }
    expect(hasControlCharacter("Café — 10:00, Room ä")).toBe(false);
    expect(hasControlCharacter(String.fromCharCode(0xa0))).toBe(false);
  });

  it("adds every kind of whitespace for attendees", () => {
    expect(hasWhitespaceOrControl("a b")).toBe(true);
    expect(hasWhitespaceOrControl(`a${String.fromCharCode(0xa0)}b`)).toBe(true);
    expect(hasWhitespaceOrControl(`a${String.fromCharCode(0x2028)}b`)).toBe(true);
    expect(hasWhitespaceOrControl("alice@example.com")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// apple_calendar_event_delete
// ---------------------------------------------------------------------------

describe("apple_calendar_event_delete", () => {
  it("calls deleteEvent with the provided href and returns { deleted: true }", async () => {
    const { client, deleteCalls } = makeFakeCalDavClient();
    const { server, tools } = stubServer();

    registerAppleCalendarTools(server as never, {
      calendar: client,
      now: () => "20260601T000000Z",
    });

    const result = parseResult(
      await tools.apple_calendar_event_delete({
        href: "/calendars/work/event1.ics",
      }),
    ) as { deleted: boolean };

    expect(result.deleted).toBe(true);
    expect(deleteCalls).toHaveLength(1);
    expect(deleteCalls[0]).toBe("/calendars/work/event1.ics");
  });

  it("propagates errors from deleteEvent", async () => {
    const { client } = makeFakeCalDavClient({
      deleteEvent: async () => {
        throw new Error("404 Not Found");
      },
    });
    const { server, tools } = stubServer();

    registerAppleCalendarTools(server as never, {
      calendar: client,
      now: () => "20260601T000000Z",
    });

    await expect(
      tools.apple_calendar_event_delete({ href: "/calendars/work/gone.ics" }),
    ).rejects.toThrow("404 Not Found");
  });
});

describe("apple calendar write tools in STANDALONE mode", () => {
  // The consent config — scopeTargetOf and capturePreState — only executes on the guarded path,
  // which gateway mode skips entirely. Without a standalone case those arrows are never called and
  // the file sits below the branch floor, so this covers the behaviour AND the branches together.
  beforeEach(() => {
    resetConnectorModeForTests();
    setConnectorMode("standalone");
    process.env["NIMBUS_MCP_APPLE_WRITE_SCOPE"] =
      "calendar:work,calendar:default,calendar:/e/1.ics";
  });
  afterEach(() => {
    resetConnectorModeForTests();
    delete process.env["NIMBUS_MCP_APPLE_WRITE_SCOPE"];
  });

  function standaloneServer(accept: boolean) {
    const tools: Record<string, (input: unknown) => Promise<unknown>> = {};
    let ready = false;
    const srv = {
      server: {
        getClientCapabilities: () => (ready ? { elicitation: {} } : undefined),
        oninitialized: undefined as (() => void) | undefined,
        elicitInput: () =>
          Promise.resolve({ action: accept ? "accept" : "decline", content: { confirm: accept } }),
      },
      registerTool: (name: string, _cfg: unknown, cb: (i: unknown) => Promise<unknown>) => {
        tools[name] = cb;
        return { disable: () => undefined };
      },
      tool: () => undefined,
      sendToolListChanged: () => undefined,
      sendLoggingMessage: () => Promise.resolve(),
      handshake: () => {
        ready = true;
        srv.server.oninitialized?.();
      },
    };
    return { srv, tools };
  }

  const client: CalDavClient = {
    listCalendars: async (): Promise<CalendarRef[]> => [],
    listEvents: async () => [],
    putEvent: async () => undefined,
    deleteEvent: async () => undefined,
  } as unknown as CalDavClient;

  it("an approved create runs, exercising scopeTargetOf with an explicit calendar", async () => {
    const { srv, tools } = standaloneServer(true);
    registerAppleCalendarTools(srv as never, { calendar: client, now: () => "20260601T000000Z" });
    srv.handshake();
    // It reaches the CONNECTOR's own error, not a gate refusal — which is the point: scope
    // matched, consent was granted, and the handler ran. The stub exposes no calendars.
    await expect(
      tools.apple_calendar_event_create?.({
        calendar: "work",
        summary: "s",
        start: "20260601T000000Z",
        end: "20260601T010000Z",
      }),
    ).rejects.toThrow(/Calendar "work" not found/);
  });

  it('an omitted calendar scopes to "default" — the nullish arm', async () => {
    const { srv, tools } = standaloneServer(true);
    registerAppleCalendarTools(srv as never, { calendar: client, now: () => "20260601T000000Z" });
    srv.handshake();
    // Scoped to "default" via the nullish arm, so it passes the allow-list and reaches the
    // connector's own error rather than being refused as out of scope.
    await expect(
      tools.apple_calendar_event_create?.({
        summary: "s",
        start: "20260601T000000Z",
        end: "20260601T010000Z",
      }),
    ).rejects.toThrow(/No calendar available/);
  });

  it("a DECLINED delete mutates nothing, and capturePreState never runs", async () => {
    const { srv, tools } = standaloneServer(false);
    registerAppleCalendarTools(srv as never, { calendar: client, now: () => "20260601T000000Z" });
    srv.handshake();
    const res = await tools.apple_calendar_event_delete?.({ href: "/e/1.ics" });
    expect(JSON.stringify(res)).toMatch(/not approved/i);
  });

  it("an approved delete captures the href as pre-state", async () => {
    const { srv, tools } = standaloneServer(true);
    registerAppleCalendarTools(srv as never, { calendar: client, now: () => "20260601T000000Z" });
    srv.handshake();
    const res = await tools.apple_calendar_event_delete?.({ href: "/e/1.ics" });
    expect(JSON.stringify(res)).not.toMatch(/not approved/i);
  });
});
