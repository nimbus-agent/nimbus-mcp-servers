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
import { resetConnectorModeForTests, setConnectorMode } from "../../../shared/connector-mode.ts";
import { OUTLOOK_TOOL_NAMES, registerOutlookTools } from "../src/tools.ts";

const GRAPH = "https://graph.microsoft.com/v1.0";
const NEXT = `${GRAPH}/me/somewhere?$skiptoken=abc`;

let tools: CapturedTools;
let http: FetchStub | undefined;

function serve(reply: StubReply | ((req: RecordedRequest) => StubReply | undefined)): FetchStub {
  http?.restore();
  http = stubFetch(reply);
  return http;
}

/** Register with MICROSOFT_OAUTH_SCOPES as given (undefined = no scope gating at all). */
async function register(scopes: string | undefined): Promise<CapturedTools> {
  let captured: CapturedTools | undefined;
  await withEnv({ MICROSOFT_OAUTH_SCOPES: scopes }, () => {
    captured = captureTools(registerOutlookTools);
  });
  if (captured === undefined) throw new Error("registration did not run");
  return captured;
}

/** Call a tool with the access token set, and return the one request it made. */
async function only(name: string, args: Record<string, unknown>): Promise<RecordedRequest> {
  const stub = http ?? serve('{"value":[]}');
  await withEnv({ MICROSOFT_OAUTH_ACCESS_TOKEN: "graph-token" }, async () => {
    await tools.call(name, args);
  });
  return stub.only;
}

beforeEach(async () => {
  resetConnectorModeForTests();
  setConnectorMode("gateway");
  tools = await register(undefined);
});

afterEach(() => {
  http?.restore();
  http = undefined;
  resetConnectorModeForTests();
});

describe("outlook tool registration", () => {
  it("registers every tool, in OUTLOOK_TOOL_NAMES order, when no scopes are declared", () => {
    expect(tools.registrationOrder()).toEqual([...OUTLOOK_TOOL_NAMES]);
  });

  it("registers only what the granted Microsoft scopes allow", async () => {
    const calendarReader = await register("Calendars.Read offline_access");
    expect(calendarReader.registrationOrder()).toEqual([
      "outlook_calendar_list",
      "outlook_calendar_get",
    ]);
    const mailer = await register("Mail.ReadWrite Mail.Send");
    expect(mailer.registrationOrder()).toEqual([
      "outlook_mail_folders",
      "outlook_mail_list",
      "outlook_mail_read",
      "outlook_mail_send",
    ]);
  });
});

describe("outlook read tools", () => {
  it("mail_folders lists 50 by default with the bearer token", async () => {
    const req = await only("outlook_mail_folders", {});
    expect(req.url).toBe(`${GRAPH}/me/mailFolders?$top=50`);
    expect(req.headers["authorization"]).toBe("Bearer graph-token");
  });

  it("mail_folders honours top", async () => {
    expect((await only("outlook_mail_folders", { top: 7 })).url).toBe(
      `${GRAPH}/me/mailFolders?$top=7`,
    );
  });

  it("every paginated list follows nextLink verbatim", async () => {
    for (const [name, args] of [
      ["outlook_mail_folders", { nextLink: NEXT }],
      ["outlook_mail_list", { nextLink: NEXT, folderId: "ignored" }],
      ["outlook_calendar_list", { nextLink: NEXT, startDateTime: "a", endDateTime: "b" }],
      ["outlook_contact_list", { nextLink: NEXT, top: 3 }],
    ] as const) {
      serve('{"value":[]}');
      expect((await only(name, args)).url).toBe(NEXT);
    }
  });

  it("mail_list reads the inbox, 25 at a time, selecting only metadata", async () => {
    const url = new URL((await only("outlook_mail_list", {})).url);
    expect(`${url.origin}${url.pathname}`).toBe(`${GRAPH}/me/mailFolders/inbox/messages`);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      $top: "25",
      $skip: "0",
      $select:
        "id,subject,bodyPreview,receivedDateTime,lastModifiedDateTime,hasAttachments,webLink",
    });
  });

  it("mail_list encodes the folder id and passes top, skip and filter", async () => {
    const url = new URL(
      (
        await only("outlook_mail_list", {
          folderId: "Archive/2026",
          top: 5,
          skip: 10,
          filter: "isRead eq false",
        })
      ).url,
    );
    expect(url.pathname).toBe("/v1.0/me/mailFolders/Archive%2F2026/messages");
    expect(url.searchParams.get("$top")).toBe("5");
    expect(url.searchParams.get("$skip")).toBe("10");
    expect(url.searchParams.get("$filter")).toBe("isRead eq false");
  });

  it("mail_read expands attachments of one encoded message id", async () => {
    expect((await only("outlook_mail_read", { messageId: "AAMk/1=" })).url).toBe(
      `${GRAPH}/me/messages/AAMk%2F1%3D?$expand=attachments`,
    );
  });

  it("calendar_list encodes the window and defaults top to 50", async () => {
    expect(
      (
        await only("outlook_calendar_list", {
          startDateTime: "2026-10-01T00:00:00+02:00",
          endDateTime: "2026-10-08T00:00:00+02:00",
        })
      ).url,
    ).toBe(
      `${GRAPH}/me/calendarView?startDateTime=2026-10-01T00%3A00%3A00%2B02%3A00&endDateTime=2026-10-08T00%3A00%3A00%2B02%3A00&$top=50`,
    );
  });

  it("calendar_get and contact_get address one encoded id", async () => {
    expect((await only("outlook_calendar_get", { eventId: "ev/1" })).url).toBe(
      `${GRAPH}/me/events/ev%2F1`,
    );
    serve('{"id":"c"}');
    expect((await only("outlook_contact_get", { contactId: "c 1" })).url).toBe(
      `${GRAPH}/me/contacts/c%201`,
    );
  });

  it("contact_list pages with top and skip", async () => {
    expect((await only("outlook_contact_list", {})).url).toBe(
      `${GRAPH}/me/contacts?$top=50&$skip=0`,
    );
    serve('{"value":[]}');
    expect((await only("outlook_contact_list", { top: 20, skip: 40 })).url).toBe(
      `${GRAPH}/me/contacts?$top=20&$skip=40`,
    );
  });

  it("a read refuses without the access token, before any request", async () => {
    const stub = serve("{}");
    await withEnv({ MICROSOFT_OAUTH_ACCESS_TOKEN: undefined }, async () => {
      await expect(tools.call("outlook_mail_folders", {})).rejects.toThrow(
        "MICROSOFT_OAUTH_ACCESS_TOKEN is not set",
      );
    });
    expect(stub.calls).toEqual([]);
  });
});

describe("outlook_mail_send", () => {
  async function send(args: Record<string, unknown>): Promise<RecordedRequest> {
    serve({ status: 202, body: "" });
    return only("outlook_mail_send", args);
  }

  it("POSTs a plain-text message to the listed recipients and saves it to Sent", async () => {
    const req = await send({ to: "ana@example.com, ,bo@example.com ", subject: "Hi", body: "Hey" });
    expect(req.method).toBe("POST");
    expect(req.url).toBe(`${GRAPH}/me/sendMail`);
    expect(req.headers["content-type"]).toBe("application/json");
    expect(JSON.parse(req.body ?? "null")).toEqual({
      message: {
        subject: "Hi",
        body: { contentType: "Text", content: "Hey" },
        toRecipients: [
          { emailAddress: { address: "ana@example.com" } },
          { emailAddress: { address: "bo@example.com" } },
        ],
      },
      saveToSentItems: true,
    });
  });

  it("sends HTML and copies the cc list, dropping empty entries", async () => {
    const req = await send({
      to: "ana@example.com",
      subject: "Report",
      body: "<p>hi</p>",
      contentType: "html",
      cc: " cy@example.com,, dee@example.com",
    });
    const message = (JSON.parse(req.body ?? "null") as { message: Record<string, unknown> })
      .message;
    expect(message["body"]).toEqual({ contentType: "HTML", content: "<p>hi</p>" });
    expect(message["ccRecipients"]).toEqual([
      { emailAddress: { address: "cy@example.com" } },
      { emailAddress: { address: "dee@example.com" } },
    ]);
  });

  it("returns ok, and throws Graph's status and body on a failed send", async () => {
    serve({ status: 202, body: "" });
    await withEnv({ MICROSOFT_OAUTH_ACCESS_TOKEN: "graph-token" }, async () => {
      expect(
        await tools.callJson("outlook_mail_send", { to: "a@example.com", subject: "s", body: "b" }),
      ).toEqual({ ok: true });
    });
    serve({ status: 400, body: "ErrorInvalidRecipients" });
    await withEnv({ MICROSOFT_OAUTH_ACCESS_TOKEN: "graph-token" }, async () => {
      await expect(
        tools.call("outlook_mail_send", { to: "nope", subject: "s", body: "b" }),
      ).rejects.toThrow("Graph 400: ErrorInvalidRecipients");
    });
  });

  it("refuses a header-injected recipient before sending anything", async () => {
    const stub = serve("{}");
    await withEnv({ MICROSOFT_OAUTH_ACCESS_TOKEN: "graph-token" }, async () => {
      await expect(
        tools.call("outlook_mail_send", {
          to: "ana@example.com\r\nBcc: eve@example.com",
          subject: "s",
          body: "b",
        }),
      ).rejects.toThrow("must not contain a line break");
    });
    expect(stub.calls).toEqual([]);
  });
});

describe("outlook calendar writes", () => {
  it("calendar_create POSTs a UTC event with no body or attendees by default", async () => {
    const stub = serve('{"id":"new-event"}');
    let out: unknown;
    await withEnv({ MICROSOFT_OAUTH_ACCESS_TOKEN: "graph-token" }, async () => {
      out = await tools.callJson("outlook_calendar_create", {
        subject: "Standup",
        startDateTime: "2026-10-05T09:00:00",
        endDateTime: "2026-10-05T09:15:00",
      });
    });
    expect(out).toEqual({ id: "new-event" });
    expect(stub.only.method).toBe("POST");
    expect(stub.only.url).toBe(`${GRAPH}/me/events`);
    expect(JSON.parse(stub.only.body ?? "null")).toEqual({
      subject: "Standup",
      start: { dateTime: "2026-10-05T09:00:00", timeZone: "UTC" },
      end: { dateTime: "2026-10-05T09:15:00", timeZone: "UTC" },
    });
  });

  it("calendar_create carries the time zone, a text body and required attendees", async () => {
    const req = await (async () => {
      serve('{"id":"e"}');
      return only("outlook_calendar_create", {
        subject: "Planning",
        startDateTime: "2026-10-06T14:00:00",
        endDateTime: "2026-10-06T15:00:00",
        timeZone: "Europe/Berlin",
        body: "Agenda: Q4",
        attendees: "ana@example.com, , bo@example.com",
      });
    })();
    expect(JSON.parse(req.body ?? "null")).toEqual({
      subject: "Planning",
      start: { dateTime: "2026-10-06T14:00:00", timeZone: "Europe/Berlin" },
      end: { dateTime: "2026-10-06T15:00:00", timeZone: "Europe/Berlin" },
      body: { contentType: "Text", content: "Agenda: Q4" },
      attendees: [
        { emailAddress: { address: "ana@example.com" }, type: "required" },
        { emailAddress: { address: "bo@example.com" }, type: "required" },
      ],
    });
  });

  it("calendar_delete DELETEs one encoded event and reports ok", async () => {
    const stub = serve({ status: 204, body: "" });
    let out: unknown;
    await withEnv({ MICROSOFT_OAUTH_ACCESS_TOKEN: "graph-token" }, async () => {
      out = await tools.callJson("outlook_calendar_delete", { eventId: "AAMk/9" });
    });
    expect(out).toEqual({ ok: true });
    expect(stub.only.method).toBe("DELETE");
    expect(stub.only.url).toBe(`${GRAPH}/me/events/AAMk%2F9`);
  });

  it("calendar_delete throws Graph's status and body when the event cannot be deleted", async () => {
    serve({ status: 404, body: "ErrorItemNotFound" });
    await withEnv({ MICROSOFT_OAUTH_ACCESS_TOKEN: "graph-token" }, async () => {
      await expect(tools.call("outlook_calendar_delete", { eventId: "gone" })).rejects.toThrow(
        "Graph 404: ErrorItemNotFound",
      );
    });
  });
});
