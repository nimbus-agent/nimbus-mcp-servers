import { describe, expect, it } from "bun:test";
import {
  type AppendCapableFlow,
  buildRfc822Message,
  createAppleCalDavClient,
  createAppleDraftAppender,
  createAppleImapClient,
  createAppleSmtpMailer,
  type DavClientLike,
  DRAFTS_MAILBOX,
  ICLOUD_IMAP_HOST,
  ICLOUD_IMAP_PORT,
  ICLOUD_SMTP_HOST,
  ICLOUD_SMTP_PORT,
  icalTimestamp,
} from "../src/adapters.ts";

describe("createAppleImapClient", () => {
  it("connects to iCloud IMAP over implicit TLS", async () => {
    const constructed: unknown[] = [];
    const flow = {
      mailbox: { uidValidity: 1 },
      connect: async (): Promise<void> => undefined,
      logout: async (): Promise<void> => undefined,
      getMailboxLock: async () => ({ release: (): undefined => undefined }),
      status: async () => ({ messages: 0 }),
      fetch: async function* () {
        // no messages
      },
      fetchOne: async () => false,
      search: async () => [],
    };
    const client = createAppleImapClient("me@icloud.test", "app-pw", (options) => {
      constructed.push(options);
      return flow as never;
    });
    expect(await client.list({})).toEqual([]);
    expect(constructed[0]).toEqual({
      host: ICLOUD_IMAP_HOST,
      port: ICLOUD_IMAP_PORT,
      secure: true,
      auth: { user: "me@icloud.test", pass: "app-pw" },
      logger: false,
    });
  });
});

describe("createAppleSmtpMailer", () => {
  it("uses STARTTLS on 587 and refuses a plaintext fallback", () => {
    const options: unknown[] = [];
    createAppleSmtpMailer("me@icloud.test", "app-pw", (o) => {
      options.push(o);
      return { sendMail: async () => ({}) } as never;
    });
    expect(options[0]).toEqual({
      host: ICLOUD_SMTP_HOST,
      port: ICLOUD_SMTP_PORT,
      secure: false,
      // Without this nodemailer would fall back to plaintext if the server
      // failed to advertise STARTTLS, putting the app password on the wire.
      requireTLS: true,
      auth: { user: "me@icloud.test", pass: "app-pw" },
    });
  });

  it("pins the sender to the authenticated address", async () => {
    const sent: { from?: string }[] = [];
    const mailer = createAppleSmtpMailer(
      "me@icloud.test",
      "app-pw",
      () =>
        ({
          sendMail: async (mail: { from?: string }) => {
            sent.push(mail);
            return {};
          },
        }) as never,
    );
    await mailer.send({ to: "you@example.test", subject: "s", body: "b" });
    expect(sent[0]?.from).toBe("me@icloud.test");
  });
});

describe("buildRfc822Message", () => {
  it("pins From, uses CRLF, and base64-encodes the body", () => {
    const raw = buildRfc822Message("me@icloud.test", {
      to: "you@example.test",
      subject: "Hi",
      body: "héllo",
    });
    expect(raw.startsWith("From: me@icloud.test\r\nTo: you@example.test\r\n")).toBe(true);
    expect(raw).toContain("Content-Transfer-Encoding: base64");
    const body = raw.split("\r\n\r\n")[1] ?? "";
    expect(Buffer.from(body, "base64").toString("utf8")).toBe("héllo");
  });

  it("includes Cc and Bcc only when non-empty", () => {
    const base = { to: "you@example.test", subject: "s", body: "b" };
    expect(buildRfc822Message("me@icloud.test", { ...base, cc: "", bcc: "" })).not.toContain("Cc:");
    const withBoth = buildRfc822Message("me@icloud.test", {
      ...base,
      cc: "c@example.test",
      bcc: "b@example.test",
    });
    expect(withBoth).toContain("Cc: c@example.test");
    expect(withBoth).toContain("Bcc: b@example.test");
  });

  it("wraps the base64 payload at 76 characters, per RFC 2045", () => {
    const raw = buildRfc822Message("me@icloud.test", {
      to: "you@example.test",
      subject: "s",
      body: "x".repeat(500),
    });
    const body = raw.split("\r\n\r\n")[1] ?? "";
    for (const line of body.split("\r\n")) {
      expect(line.length).toBeLessThanOrEqual(76);
    }
    expect(Buffer.from(body.replaceAll("\r\n", ""), "base64").toString("utf8")).toBe(
      "x".repeat(500),
    );
  });
});

describe("createAppleDraftAppender", () => {
  function fakeFlow(appendResult: unknown): {
    flow: AppendCapableFlow;
    calls: { mailbox: string; flags: string[]; content: string }[];
    closed: number;
  } {
    const calls: { mailbox: string; flags: string[]; content: string }[] = [];
    const state = { closed: 0 };
    return {
      calls,
      get closed(): number {
        return state.closed;
      },
      flow: {
        connect: async (): Promise<void> => undefined,
        logout: async (): Promise<void> => {
          state.closed += 1;
        },
        append: async (mailbox: string, content: Buffer, flags: string[]) => {
          calls.push({ mailbox, flags, content: content.toString("utf8") });
          return appendResult;
        },
      },
    };
  }

  it("APPENDs a \\Draft-flagged message to the Drafts mailbox", async () => {
    const fake = fakeFlow({ uid: 12 });
    const appender = createAppleDraftAppender("me@icloud.test", "pw", () => fake.flow);
    expect(await appender.appendDraft({ to: "you@example.test", subject: "s", body: "b" })).toEqual(
      { uid: 12, mailbox: DRAFTS_MAILBOX },
    );
    expect(fake.calls[0]?.mailbox).toBe(DRAFTS_MAILBOX);
    expect(fake.calls[0]?.flags).toEqual(["\\Draft"]);
    expect(fake.calls[0]?.content).toContain("From: me@icloud.test");
  });

  it("reports a null uid when the server supports neither APPENDUID nor UIDPLUS", async () => {
    const fake = fakeFlow(undefined);
    const appender = createAppleDraftAppender("me@icloud.test", "pw", () => fake.flow);
    expect(
      (await appender.appendDraft({ to: "you@example.test", subject: "s", body: "b" })).uid,
    ).toBeNull();
  });

  it("logs out even when the APPEND fails", async () => {
    const fake = fakeFlow(undefined);
    const failing: AppendCapableFlow = {
      ...fake.flow,
      append: (): Promise<never> => Promise.reject(new Error("APPEND rejected")),
    };
    const appender = createAppleDraftAppender("me@icloud.test", "pw", () => failing);
    await expect(
      appender.appendDraft({ to: "you@example.test", subject: "s", body: "b" }),
    ).rejects.toThrow("APPEND rejected");
    expect(fake.closed).toBe(1);
  });
});

describe("createAppleCalDavClient", () => {
  const ICS =
    "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:e1\r\nSUMMARY:Standup\r\nDTSTART:20260102T090000Z\r\nDTEND:20260102T091500Z\r\nEND:VEVENT\r\nEND:VCALENDAR";

  function fakeDav(overrides: Partial<DavClientLike> = {}): {
    dav: DavClientLike;
    calls: Record<string, unknown[]>;
  } {
    const calls: Record<string, unknown[]> = {};
    const record = (op: string, arg: unknown): void => {
      const seen = calls[op] ?? [];
      seen.push(arg);
      calls[op] = seen;
    };
    const dav: DavClientLike = {
      login: async () => {
        record("login", null);
        return undefined;
      },
      fetchCalendars: async () => {
        record("fetchCalendars", null);
        return [
          { url: "https://p01.icloud.test/cal/home/", displayName: "Home" },
          { url: "https://p01.icloud.test/cal/unnamed/", displayName: "" },
        ];
      },
      fetchCalendarObjects: async (p) => {
        record("fetchCalendarObjects", p);
        return [
          { url: "https://p01.icloud.test/cal/home/e1.ics", data: ICS },
          { url: "https://p01.icloud.test/cal/home/skip.ics", data: "" },
          { url: "https://p01.icloud.test/cal/home/nodata.ics" },
        ];
      },
      createCalendarObject: async (p) => {
        record("createCalendarObject", p);
        return undefined;
      },
      deleteCalendarObject: async (p) => {
        record("deleteCalendarObject", p);
        return undefined;
      },
      ...overrides,
    };
    return { dav, calls };
  }

  it("logs in through the bootstrap host before anything else", async () => {
    const fake = fakeDav();
    await createAppleCalDavClient("me@icloud.test", "pw", () => fake.dav).login();
    expect(fake.calls["login"]).toHaveLength(1);
  });

  it("falls back to the url as the display name when the calendar has none", async () => {
    const fake = fakeDav();
    const cals = await createAppleCalDavClient(
      "me@icloud.test",
      "pw",
      () => fake.dav,
    ).listCalendars();
    expect(cals).toEqual([
      { url: "https://p01.icloud.test/cal/home/", displayName: "Home" },
      {
        url: "https://p01.icloud.test/cal/unnamed/",
        displayName: "https://p01.icloud.test/cal/unnamed/",
      },
    ]);
  });

  it("asks the server to expand recurrences, and skips objects with no data", async () => {
    const fake = fakeDav();
    const client = createAppleCalDavClient("me@icloud.test", "pw", () => fake.dav);
    const events = await client.listEvents(
      { url: "https://p01.icloud.test/cal/home/", displayName: "Home" },
      { startUtc: "20260101T000000Z", endUtc: "20260201T000000Z" },
    );
    expect(events).toHaveLength(1);
    expect(events[0]?.href).toBe("https://p01.icloud.test/cal/home/e1.ics");
    expect(events[0]?.event.summary).toBe("Standup");
    const params = fake.calls["fetchCalendarObjects"]?.[0] as { expand?: boolean };
    expect(params.expand).toBe(true);
  });

  it("uses the discovered calendar object once listCalendars has run", async () => {
    const fake = fakeDav();
    const client = createAppleCalDavClient("me@icloud.test", "pw", () => fake.dav);
    const ref = { url: "https://p01.icloud.test/cal/home/", displayName: "Home" };

    // Before discovery: a bare { url }.
    await client.listEvents(ref, { startUtc: "20260101T000000Z", endUtc: "20260201T000000Z" });
    const first = fake.calls["fetchCalendarObjects"]?.[0] as { calendar: unknown } | undefined;
    expect(first?.calendar).toEqual({ url: ref.url });

    // After discovery: the full DAVCalendar, which carries the account binding
    // tsdav needs to authenticate against the resolved host.
    await client.listCalendars();
    await client.listEvents(ref, { startUtc: "20260101T000000Z", endUtc: "20260201T000000Z" });
    const second = fake.calls["fetchCalendarObjects"]?.[1] as { calendar: unknown } | undefined;
    expect(second?.calendar).toEqual({ url: ref.url, displayName: "Home" });
  });

  it("sanitises the uid into the object filename and returns the joined href", async () => {
    const fake = fakeDav();
    const client = createAppleCalDavClient("me@icloud.test", "pw", () => fake.dav);
    const { href } = await client.putEvent(
      { url: "https://p01.icloud.test/cal/home", displayName: "Home" },
      "a/b#c",
      ICS,
    );
    const created = fake.calls["createCalendarObject"]?.[0] as { filename: string };
    expect(created.filename).not.toContain("/");
    expect(href).toBe(`https://p01.icloud.test/cal/home/${created.filename}`);
  });

  it("does not double the slash when the calendar url already ends in one", async () => {
    const fake = fakeDav();
    const client = createAppleCalDavClient("me@icloud.test", "pw", () => fake.dav);
    const { href } = await client.putEvent(
      { url: "https://p01.icloud.test/cal/home/", displayName: "Home" },
      "e1",
      ICS,
    );
    expect(href).not.toContain("home//");
  });

  it("deletes unconditionally by href", async () => {
    const fake = fakeDav();
    const client = createAppleCalDavClient("me@icloud.test", "pw", () => fake.dav);
    await client.deleteEvent("https://p01.icloud.test/cal/home/e1.ics");
    expect(fake.calls["deleteCalendarObject"]?.[0]).toEqual({
      calendarObject: { url: "https://p01.icloud.test/cal/home/e1.ics", etag: "" },
    });
  });
});

describe("icalTimestamp", () => {
  it("emits RFC 5545 basic format, not ISO-8601", () => {
    expect(icalTimestamp(new Date("2026-01-02T03:04:05.678Z"))).toBe("20260102T030405Z");
  });
});
