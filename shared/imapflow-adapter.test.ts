import { describe, expect, it } from "bun:test";
import type { FetchMessageObject, ImapFlow } from "imapflow";
import type { Transporter } from "nodemailer";
import { PREVIEW_FETCH_BYTES } from "./imap-mail-core.ts";
import {
  createImapFlowClient,
  createNodemailerMailer,
  type ImapEndpointConfig,
  previewFetchQuery,
  type SmtpEndpointConfig,
  type SmtpTransportOptions,
  toMessageMeta,
} from "./imapflow-adapter.ts";

/**
 * A recording stand-in for the imapflow client. The adapter's whole point is
 * that this seam exists: before the extraction the `new ImapFlow(...)` call sat
 * inline in each connector's entry point, so none of the logic below could be
 * reached without opening a socket.
 */
interface FakeCall {
  readonly op: string;
  readonly args: readonly unknown[];
}

function makeMessage(
  uid: number,
  subject: string,
  parts?: Map<string, Buffer>,
): FetchMessageObject {
  return {
    uid,
    envelope: {
      date: new Date("2026-01-02T03:04:05.000Z"),
      subject,
      messageId: `<${String(uid)}@example.test>`,
      from: [{ name: "Sender", address: "s@example.test" }],
      to: [{ address: "r@example.test" }],
      cc: [],
    },
    bodyStructure: { type: "text/plain", part: "1" },
    ...(parts === undefined ? {} : { bodyParts: parts }),
  } as unknown as FetchMessageObject;
}

interface FakeImapOptions {
  readonly messages?: readonly FetchMessageObject[];
  readonly total?: number;
  readonly searchUids?: number[] | false;
  readonly fetchOne?: FetchMessageObject | false;
  readonly mailbox?: false | { uidValidity: number };
  /** Make `fetchOne` reject, to drive the lock-release-on-failure path. */
  readonly fetchOneThrows?: boolean;
  /** Make `getMailboxLock` reject, to drive the connection-close-on-failure path. */
  readonly lockThrows?: boolean;
}

function makeFakeImap(opts: FakeImapOptions = {}): {
  factory: (options: unknown) => ImapFlow;
  calls: FakeCall[];
  constructedWith: unknown[];
  released: number;
  loggedOut: number;
} {
  const calls: FakeCall[] = [];
  const constructedWith: unknown[] = [];
  const state = { released: 0, loggedOut: 0 };
  const client = {
    mailbox: opts.mailbox ?? { uidValidity: 42 },
    connect: async (): Promise<void> => {
      calls.push({ op: "connect", args: [] });
    },
    logout: async (): Promise<void> => {
      state.loggedOut += 1;
    },
    getMailboxLock: async (mailbox: string) => {
      calls.push({ op: "getMailboxLock", args: [mailbox] });
      if (opts.lockThrows === true) {
        throw new Error("mailbox does not exist");
      }
      return {
        release: (): void => {
          state.released += 1;
        },
      };
    },
    status: async (mailbox: string, query: unknown) => {
      calls.push({ op: "status", args: [mailbox, query] });
      return { messages: opts.total ?? 0 };
    },
    fetch: async function* (range: unknown, query: unknown, options?: unknown) {
      calls.push({ op: "fetch", args: [range, query, options] });
      for (const m of opts.messages ?? []) {
        yield m;
      }
    },
    fetchOne: async (range: unknown, query: unknown, options?: unknown) => {
      calls.push({ op: "fetchOne", args: [range, query, options] });
      if (opts.fetchOneThrows === true) {
        throw new Error("boom");
      }
      return opts.fetchOne ?? false;
    },
    search: async (query: unknown, options?: unknown) => {
      calls.push({ op: "search", args: [query, options] });
      return opts.searchUids ?? [];
    },
  };
  return {
    factory: (options: unknown): ImapFlow => {
      constructedWith.push(options);
      return client as unknown as ImapFlow;
    },
    calls,
    constructedWith,
    get released(): number {
      return state.released;
    },
    get loggedOut(): number {
      return state.loggedOut;
    },
  };
}

const imapConfig: ImapEndpointConfig = {
  host: "imap.example.test",
  port: 993,
  user: "u@example.test",
  pass: "secret",
  secure: true,
};

describe("previewFetchQuery", () => {
  it("requests headers, structure and only capped text parts — never a full body", () => {
    const q = previewFetchQuery();
    expect(q.envelope).toBe(true);
    expect(q.bodyStructure).toBe(true);
    expect(q.bodyParts).toEqual([
      { key: "1", start: 0, maxLength: PREVIEW_FETCH_BYTES },
      { key: "TEXT", start: 0, maxLength: PREVIEW_FETCH_BYTES },
    ]);
    // The security constraint the connectors document: no full-source request.
    expect(Object.keys(q)).not.toContain("source");
    expect(Object.keys(q)).not.toContain("bodyParts.0.full");
  });
});

describe("toMessageMeta", () => {
  it("maps envelope addresses and omits absent name/address fields", () => {
    const meta = toMessageMeta(makeMessage(7, "Hello"), "INBOX", "42");
    expect(meta.uid).toBe(7);
    expect(meta.mailbox).toBe("INBOX");
    expect(meta.uidValidity).toBe("42");
    expect(meta.envelope.subject).toBe("Hello");
    expect(meta.envelope.from).toEqual([{ name: "Sender", address: "s@example.test" }]);
    // `to` had no name — the key must be absent, not present-and-undefined.
    expect(meta.envelope.to?.[0]).toEqual({ address: "r@example.test" });
    expect(Object.hasOwn(meta.envelope.to?.[0] ?? {}, "name")).toBe(false);
  });

  it("returns an empty envelope when the message has none", () => {
    const msg = { uid: 1, bodyStructure: null } as unknown as FetchMessageObject;
    expect(toMessageMeta(msg, "INBOX", null).envelope).toEqual({});
  });

  it("extracts the capped preview from the fetched body parts", () => {
    const parts = new Map([["1", Buffer.from("line one\r\n\r\n\r\nline  two")]]);
    expect(toMessageMeta(makeMessage(1, "s", parts), "INBOX", null).preview).toBe(
      "line one\nline two",
    );
  });

  it("returns an empty preview when no body part was fetched", () => {
    expect(toMessageMeta(makeMessage(1, "s"), "INBOX", null).preview).toBe("");
  });
});

describe("createImapFlowClient", () => {
  it("passes host/port/secure/auth through and omits tls when unspecified", async () => {
    const fake = makeFakeImap();
    await createImapFlowClient(imapConfig, fake.factory).list({});
    expect(fake.constructedWith[0]).toEqual({
      host: "imap.example.test",
      port: 993,
      secure: true,
      auth: { user: "u@example.test", pass: "secret" },
      logger: false,
    });
  });

  it("passes tls.rejectUnauthorized through when set (the Bridge loopback case)", async () => {
    const fake = makeFakeImap();
    await createImapFlowClient(
      { ...imapConfig, secure: false, rejectUnauthorized: false },
      fake.factory,
    ).list({});
    expect(fake.constructedWith[0]).toMatchObject({
      secure: false,
      tls: { rejectUnauthorized: false },
    });
  });

  it("releases the mailbox lock and logs out even when the body throws", async () => {
    const throwing = makeFakeImap({ fetchOneThrows: true });
    await expect(createImapFlowClient(imapConfig, throwing.factory).get(1)).rejects.toThrow("boom");
    expect(throwing.released).toBe(1);
    expect(throwing.loggedOut).toBe(1);

    // And the non-throwing path still releases exactly once.
    const fake = makeFakeImap();
    await createImapFlowClient(imapConfig, fake.factory).list({});
    expect(fake.released).toBe(1);
    expect(fake.loggedOut).toBe(1);
  });

  it("closes the connection when the mailbox lock cannot be taken", async () => {
    // The client connects per call, so a lock failure that skipped `logout`
    // leaked one connected socket per failing call.
    const fake = makeFakeImap({ lockThrows: true });
    await expect(createImapFlowClient(imapConfig, fake.factory).list({})).rejects.toThrow(
      "mailbox does not exist",
    );
    expect(fake.loggedOut).toBe(1);
    expect(fake.released).toBe(0);
  });

  it("reports a null uidValidity when no mailbox is open", async () => {
    const fake = makeFakeImap({ mailbox: false, fetchOne: makeMessage(3, "x") });
    const meta = await createImapFlowClient(imapConfig, fake.factory).get(3);
    expect(meta?.uidValidity).toBeNull();
  });

  describe("list", () => {
    it("short-circuits without fetching when the mailbox is empty", async () => {
      const fake = makeFakeImap({ total: 0 });
      expect(await createImapFlowClient(imapConfig, fake.factory).list({})).toEqual([]);
      expect(fake.calls.map((c) => c.op)).not.toContain("fetch");
    });

    it("fetches the last `limit` messages and returns them most-recent first", async () => {
      const fake = makeFakeImap({
        total: 100,
        messages: [makeMessage(1, "old"), makeMessage(9, "new"), makeMessage(5, "mid")],
      });
      const out = await createImapFlowClient(imapConfig, fake.factory).list({ limit: 10 });
      expect(out.map((m) => m.uid)).toEqual([9, 5, 1]);
      const fetchCall = fake.calls.find((c) => c.op === "fetch");
      expect(fetchCall?.args[0]).toBe("91:100");
    });

    it("clamps the range start to 1 when the limit exceeds the message count", async () => {
      const fake = makeFakeImap({ total: 3, messages: [makeMessage(1, "a")] });
      await createImapFlowClient(imapConfig, fake.factory).list({ limit: 200 });
      expect(fake.calls.find((c) => c.op === "fetch")?.args[0]).toBe("1:3");
    });

    it("uses the configured default mailbox, and the caller's when given", async () => {
      const fake = makeFakeImap({ total: 1, messages: [makeMessage(1, "a")] });
      await createImapFlowClient({ ...imapConfig, defaultMailbox: "Archive" }, fake.factory).list(
        {},
      );
      expect(fake.calls.find((c) => c.op === "getMailboxLock")?.args[0]).toBe("Archive");

      const fake2 = makeFakeImap({ total: 1, messages: [makeMessage(1, "a")] });
      await createImapFlowClient(imapConfig, fake2.factory).list({ mailbox: "Sent" });
      expect(fake2.calls.find((c) => c.op === "getMailboxLock")?.args[0]).toBe("Sent");
      const listed = await createImapFlowClient(imapConfig, fake2.factory).list({});
      expect(listed[0]?.mailbox).toBe("INBOX");
    });
  });

  describe("get", () => {
    it("returns null when the uid does not exist", async () => {
      const fake = makeFakeImap({ fetchOne: false });
      expect(await createImapFlowClient(imapConfig, fake.factory).get(404)).toBeNull();
    });

    it("fetches by uid and stamps the mailbox it was read from", async () => {
      const fake = makeFakeImap({ fetchOne: makeMessage(12, "hi") });
      const meta = await createImapFlowClient(imapConfig, fake.factory).get(12, "Sent");
      expect(meta?.uid).toBe(12);
      expect(meta?.mailbox).toBe("Sent");
      const call = fake.calls.find((c) => c.op === "fetchOne");
      expect(call?.args[0]).toBe("12");
      expect(call?.args[2]).toEqual({ uid: true });
    });
  });

  describe("search", () => {
    it("searches subject/from/to and returns [] when nothing matches", async () => {
      const fake = makeFakeImap({ searchUids: [] });
      expect(await createImapFlowClient(imapConfig, fake.factory).search({ query: "q" })).toEqual(
        [],
      );
      expect(fake.calls.find((c) => c.op === "search")?.args[0]).toEqual({
        or: [{ subject: "q" }, { from: "q" }, { to: "q" }],
      });
    });

    it("returns [] when the server refuses the search", async () => {
      const fake = makeFakeImap({ searchUids: false });
      expect(await createImapFlowClient(imapConfig, fake.factory).search({ query: "q" })).toEqual(
        [],
      );
    });

    it("takes the newest `limit` uids and fetches them descending", async () => {
      const fake = makeFakeImap({
        searchUids: [1, 2, 3, 4, 5],
        messages: [makeMessage(4, "d"), makeMessage(5, "e"), makeMessage(3, "c")],
      });
      const out = await createImapFlowClient(imapConfig, fake.factory).search({
        query: "q",
        limit: 3,
      });
      expect(fake.calls.find((c) => c.op === "fetch")?.args[0]).toEqual([5, 4, 3]);
      expect(out.map((m) => m.uid)).toEqual([5, 4, 3]);
    });
  });
});

describe("createNodemailerMailer", () => {
  function makeFakeTransport(info: Record<string, unknown> = {}): {
    factory: TransportFactoryStub;
    options: SmtpTransportOptions[];
    sent: unknown[];
  } {
    const options: SmtpTransportOptions[] = [];
    const sent: unknown[] = [];
    return {
      options,
      sent,
      factory: (o: SmtpTransportOptions): Transporter => {
        options.push(o);
        return {
          sendMail: async (mail: unknown) => {
            sent.push(mail);
            return info;
          },
        } as unknown as Transporter;
      },
    };
  }
  type TransportFactoryStub = (o: SmtpTransportOptions) => Transporter;

  const smtpConfig: SmtpEndpointConfig = {
    host: "smtp.example.test",
    port: 465,
    user: "u@example.test",
    pass: "secret",
    secure: true,
  };

  it("builds the transport from the config and omits tls when unspecified", () => {
    const fake = makeFakeTransport();
    createNodemailerMailer(smtpConfig, fake.factory);
    expect(fake.options[0]).toEqual({
      host: "smtp.example.test",
      port: 465,
      secure: true,
      // Implicit TLS already encrypts the session, so STARTTLS is not demanded
      // on top of it.
      requireTLS: false,
      auth: { user: "u@example.test", pass: "secret" },
    });
  });

  it("REQUIRES STARTTLS whenever TLS is not implicit, without being asked", () => {
    // The gap this closes: `imap` computes `secure: port === 465`, so
    // IMAP_SMTP_PORT=587 gave `secure: false` with no requireTLS, and
    // nodemailer falls back to PLAINTEXT there when the server does not
    // advertise STARTTLS — sending the SMTP password in the clear.
    const fake = makeFakeTransport();
    createNodemailerMailer({ ...smtpConfig, port: 587, secure: false }, fake.factory);
    expect(fake.options[0]).toMatchObject({ secure: false, requireTLS: true });
  });

  it("lets a caller opt out of the STARTTLS requirement explicitly", () => {
    const fake = makeFakeTransport();
    createNodemailerMailer({ ...smtpConfig, secure: false, requireTLS: false }, fake.factory);
    expect(fake.options[0]).toMatchObject({ secure: false, requireTLS: false });
  });

  it("passes tls.rejectUnauthorized through, still demanding STARTTLS", () => {
    // The ProtonMail Bridge case: a self-signed certificate on loopback is not
    // a reason to accept an unencrypted session.
    const fake = makeFakeTransport();
    createNodemailerMailer(
      { ...smtpConfig, secure: false, rejectUnauthorized: false },
      fake.factory,
    );
    expect(fake.options[0]).toMatchObject({
      tls: { rejectUnauthorized: false },
      requireTLS: true,
    });
  });

  it("sends from the authenticated user and omits absent cc/bcc", async () => {
    const fake = makeFakeTransport({ messageId: "<id@x>", accepted: ["a@x"], rejected: [] });
    const out = await createNodemailerMailer(smtpConfig, fake.factory).send({
      to: "to@example.test",
      subject: "Subject",
      body: "Body",
    });
    expect(fake.sent[0]).toEqual({
      from: "u@example.test",
      to: "to@example.test",
      subject: "Subject",
      text: "Body",
    });
    expect(out).toEqual({ messageId: "<id@x>", accepted: ["a@x"], rejected: [] });
  });

  it("forwards cc and bcc when supplied", async () => {
    const fake = makeFakeTransport({});
    await createNodemailerMailer(smtpConfig, fake.factory).send({
      to: "to@example.test",
      subject: "s",
      body: "b",
      cc: "cc@example.test",
      bcc: "bcc@example.test",
    });
    expect(fake.sent[0]).toMatchObject({ cc: "cc@example.test", bcc: "bcc@example.test" });
  });

  it("normalises a response with no messageId or address lists", async () => {
    const fake = makeFakeTransport({});
    const out = await createNodemailerMailer(smtpConfig, fake.factory).send({
      to: "to@example.test",
      subject: "s",
      body: "b",
    });
    expect(out).toEqual({ messageId: null, accepted: [], rejected: [] });
  });

  it("stringifies nodemailer's address objects", async () => {
    const fake = makeFakeTransport({ accepted: [1, "b@x"], rejected: ["c@x"] });
    const out = await createNodemailerMailer(smtpConfig, fake.factory).send({
      to: "to@example.test",
      subject: "s",
      body: "b",
    });
    expect(out.accepted).toEqual(["1", "b@x"]);
    expect(out.rejected).toEqual(["c@x"]);
  });
});
