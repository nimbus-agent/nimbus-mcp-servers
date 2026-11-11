import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  type CapturedTools,
  captureTools,
  type FetchStub,
  type RecordedRequest,
  type StubReply,
  stubFetch,
  withEnv,
} from "../../../scripts/connector-tool-harness.ts";
import { GOOGLE_CALENDAR_TOOL_NAMES, registerGoogleCalendarTools } from "../src/tools.ts";

const API = "https://www.googleapis.com/calendar/v3";
const MIN = "2026-11-11T00:00:00Z";
const MAX = "2026-11-12T00:00:00+02:00";

let tools: CapturedTools;
let http: FetchStub | undefined;

function serve(reply: StubReply = '{"items":[]}'): FetchStub {
  http?.restore();
  http = stubFetch(reply);
  return http;
}

async function request(name: string, args: Record<string, unknown>): Promise<RecordedRequest> {
  const stub = serve();
  await withEnv({ GOOGLE_OAUTH_ACCESS_TOKEN: "ya29.cal" }, async () => {
    await tools.call(name, args);
  });
  return stub.only;
}

async function refused(name: string, args: Record<string, unknown>): Promise<void> {
  const stub = serve();
  await withEnv({ GOOGLE_OAUTH_ACCESS_TOKEN: "t" }, async () => {
    await expect(tools.call(name, args)).rejects.toThrow();
  });
  expect(stub.calls).toEqual([]);
}

beforeEach(() => {
  tools = captureTools(registerGoogleCalendarTools);
});

afterEach(() => {
  http?.restore();
  http = undefined;
});

describe("google calendar tools", () => {
  it("registers exactly the three read tools", () => {
    expect(tools.names()).toEqual(["gcal_calendar_list", "gcal_event_get", "gcal_event_list"]);
    expect([...GOOGLE_CALENDAR_TOOL_NAMES].sort()).toEqual(tools.names());
  });

  it("calendar list is one GET on the user's list, with the bearer token", async () => {
    const req = await request("gcal_calendar_list", {});
    expect(req.url).toBe(`${API}/users/me/calendarList?maxResults=100`);
    expect(req.headers["authorization"]).toBe("Bearer ya29.cal");
    expect(req.method ?? "GET").toBe("GET");
  });

  it("calendar list pages by size and token only", async () => {
    expect((await request("gcal_calendar_list", { maxResults: 5, pageToken: "t 2" })).url).toBe(
      `${API}/users/me/calendarList?maxResults=5&pageToken=t+2`,
    );
    await refused("gcal_calendar_list", { maxResults: 251 });
    await refused("gcal_calendar_list", { maxResults: 0 });
  });

  it("event list expands recurring events, ordered by start, in one bounded request", async () => {
    const req = await request("gcal_event_list", { timeMin: MIN, timeMax: MAX });
    expect(req.url).toBe(
      `${API}/calendars/primary/events?singleEvents=true&orderBy=startTime` +
        `&timeMin=${encodeURIComponent(MIN)}&timeMax=${encodeURIComponent(MAX)}&maxResults=50`,
    );
  });

  it("event list encodes the calendar id and carries size and page token", async () => {
    const req = await request("gcal_event_list", {
      calendarId: "a/b@group.calendar.google.com?x=1",
      timeMin: MIN,
      timeMax: MAX,
      maxResults: 250,
      pageToken: "p2",
    });
    expect(req.url).toContain(`${API}/calendars/a%2Fb%40group.calendar.google.com%3Fx%3D1/events?`);
    expect(req.url).toContain("maxResults=250");
    expect(req.url).toEndWith("&pageToken=p2");
  });

  it("event list refuses bad bounds before any request", async () => {
    await refused("gcal_event_list", { timeMin: MIN, timeMax: MAX, maxResults: 251 });
    await refused("gcal_event_list", { timeMin: MIN, timeMax: MAX, maxResults: 0 });
    await refused("gcal_event_list", { timeMin: "2026-11-11", timeMax: MAX });
    await refused("gcal_event_list", { timeMin: "2026-11-11T00:00:00", timeMax: MAX });
    await refused("gcal_event_list", { timeMin: MIN });
    await refused("gcal_event_list", { timeMin: MAX, timeMax: MIN });
    await refused("gcal_event_list", { timeMin: MIN, timeMax: MIN });
    await refused("gcal_event_list", { calendarId: "", timeMin: MIN, timeMax: MAX });
    await refused("gcal_event_list", { calendarId: "x".repeat(257), timeMin: MIN, timeMax: MAX });
  });

  it("event get addresses one encoded event of an encoded calendar", async () => {
    expect((await request("gcal_event_get", { eventId: "e/1 2" })).url).toBe(
      `${API}/calendars/primary/events/e%2F1%202`,
    );
    expect((await request("gcal_event_get", { calendarId: "c@x/..", eventId: "..%2f" })).url).toBe(
      `${API}/calendars/c%40x%2F../events/..%252f`,
    );
    await refused("gcal_event_get", { eventId: "" });
    await refused("gcal_event_get", { eventId: ".." });
    await refused("gcal_event_get", { calendarId: "..", eventId: "e" });
  });

  it("only ever calls www.googleapis.com with GET", async () => {
    for (const [name, args] of [
      ["gcal_calendar_list", {}],
      ["gcal_event_list", { timeMin: MIN, timeMax: MAX }],
      ["gcal_event_get", { eventId: "e" }],
    ] as const) {
      const req = await request(name, args);
      expect(new URL(req.url).host).toBe("www.googleapis.com");
      expect(req.method ?? "GET").toBe("GET");
    }
  });

  it("quotes the API's status and body, and refuses without a token", async () => {
    serve({ status: 403, body: "PERMISSION_DENIED" });
    await withEnv({ GOOGLE_OAUTH_ACCESS_TOKEN: "t" }, async () => {
      await expect(tools.call("gcal_calendar_list", {})).rejects.toThrow(
        "Google Calendar API 403: PERMISSION_DENIED",
      );
    });
    const stub = serve();
    await withEnv({ GOOGLE_OAUTH_ACCESS_TOKEN: undefined }, async () => {
      await expect(tools.call("gcal_event_list", { timeMin: MIN, timeMax: MAX })).rejects.toThrow(
        "GOOGLE_OAUTH_ACCESS_TOKEN is not set",
      );
    });
    expect(stub.calls).toEqual([]);
  });
});
