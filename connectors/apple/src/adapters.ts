/**
 * The real iCloud clients: IMAP, SMTP, IMAP-APPEND drafts and CalDAV.
 *
 * These used to live in `server.ts`, under a comment explaining that the
 * imapflow message-shaping helpers were "copied locally; cross-importing
 * ../../imap/src/* is forbidden … server.ts is coverage-excluded so this copy
 * is acceptable". Both halves of that reasoning have since stopped holding:
 * the shared copy now lives in `shared/imapflow-adapter.ts`, which every
 * connector may import, and `server.ts` is no longer coverage-excluded. What
 * the copy actually cost was 45 duplicated lines against the imap connector and
 * a divergence that mattered — the shared `withMailbox` leaked a connection
 * when the mailbox lock failed, and this file's version was the one that had it
 * right.
 *
 * So the IMAP and SMTP clients are now the shared adapter with iCloud's
 * configuration, and only what is genuinely Apple-specific is written out here:
 * the Drafts APPEND and the two-phase CalDAV login.
 *
 * Nothing here constructs itself at import time, so a test can build any of it
 * against a fake and never open a socket.
 */

import { type ParsedEvent, parseICalendar } from "@nimbus-dev/sdk";
import { ImapFlow } from "imapflow";
import { type DAVCalendar, DAVClient } from "tsdav";
import {
  createImapFlowClient,
  createNodemailerMailer,
  type ImapFlowFactory,
  type TransportFactory,
} from "../../../shared/imapflow-adapter.ts";
import type {
  DraftAppender,
  DraftInput,
  DraftResult,
  EmailReadClient,
  EmailSendMailer,
} from "./apple-mail-core.ts";
import type { EventWindow } from "./caldav-core.ts";
import { type CalDavClient, type CalendarRef, caldavObjectFilename } from "./caldav-core.ts";

// ---------------------------------------------------------------------------
// Fixed iCloud endpoints
// ---------------------------------------------------------------------------

export const ICLOUD_IMAP_HOST = "imap.mail.me.com";
export const ICLOUD_IMAP_PORT = 993;
export const ICLOUD_SMTP_HOST = "smtp.mail.me.com";
export const ICLOUD_SMTP_PORT = 587;
export const ICLOUD_CALDAV_BOOTSTRAP_URL = "https://caldav.icloud.com";
export const DRAFTS_MAILBOX = "Drafts";

/** The iCloud IMAP read client. */
export function createAppleImapClient(
  user: string,
  pass: string,
  newImapFlow?: ImapFlowFactory,
): EmailReadClient {
  return createImapFlowClient(
    { host: ICLOUD_IMAP_HOST, port: ICLOUD_IMAP_PORT, user, pass, secure: true },
    newImapFlow,
  );
}

/**
 * The iCloud SMTP mailer.
 *
 * Port 587 is STARTTLS, not implicit TLS. The shared mailer requires STARTTLS
 * whenever TLS is not implicit and offers no way to opt out, so the credentials
 * cannot reach the wire unencrypted; iCloud always advertises it. `from` is
 * pinned to the authenticated address by the shared mailer.
 */
export function createAppleSmtpMailer(
  user: string,
  pass: string,
  makeTransport?: TransportFactory,
): EmailSendMailer {
  return createNodemailerMailer(
    { host: ICLOUD_SMTP_HOST, port: ICLOUD_SMTP_PORT, user, pass, secure: false },
    makeTransport,
  );
}

// ---------------------------------------------------------------------------
// DraftAppender — IMAP APPEND to "Drafts" via imapflow
// From is PINNED to the authenticated icloud_email (forced sender contract).
// ---------------------------------------------------------------------------

/**
 * Build a minimal RFC 5322 message from the given inputs.
 * The From header is always set to `from` (the pinned icloud_email).
 */
export function buildRfc822Message(from: string, input: DraftInput): string {
  const lines: string[] = [];
  lines.push(`From: ${from}`, `To: ${input.to}`);
  if (input.cc !== undefined && input.cc !== "") {
    lines.push(`Cc: ${input.cc}`);
  }
  if (input.bcc !== undefined && input.bcc !== "") {
    lines.push(`Bcc: ${input.bcc}`);
  }
  // The body may contain non-ASCII (UTF-8) characters, so it cannot be declared
  // 7bit. Base64-encode it (wrapped at 76 chars per RFC 2045) so the APPENDed
  // message is well-formed regardless of content.
  lines.push(
    `Subject: ${input.subject}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
  );
  const encoded = Buffer.from(input.body, "utf8").toString("base64");
  lines.push(encoded.replace(/.{76}/g, "$&\r\n"));
  // RFC 5322 uses CRLF line endings.
  return lines.join("\r\n");
}

/** Minimal imapflow surface the draft appender uses. */
export interface AppendCapableFlow {
  connect(): Promise<void>;
  logout(): Promise<void>;
  append(mailbox: string, content: Buffer, flags: string[]): Promise<unknown>;
}

class AppleDraftAppender implements DraftAppender {
  constructor(
    private readonly user: string,
    private readonly pass: string,
    private readonly newFlow: (user: string, pass: string) => AppendCapableFlow,
  ) {}

  async appendDraft(input: DraftInput): Promise<DraftResult> {
    const flow = this.newFlow(this.user, this.pass);
    await flow.connect();
    try {
      // Build the RFC 5322 message with From pinned to the authenticated email.
      const raw = buildRfc822Message(this.user, input);
      const buf = Buffer.from(raw, "utf8");

      // IMAP APPEND to the Drafts mailbox. imapflow returns the assigned UID
      // when the server supports APPENDUID or UIDPLUS — it may return undefined
      // when neither is available, which is valid.
      const result = await flow.append(DRAFTS_MAILBOX, buf, [String.raw`\Draft`]);
      const uid = (result as { uid?: number } | undefined)?.uid ?? null;
      return { uid: uid === undefined ? null : uid, mailbox: DRAFTS_MAILBOX };
    } finally {
      await flow.logout();
    }
  }
}

function realAppendFlow(user: string, pass: string): AppendCapableFlow {
  return new ImapFlow({
    host: ICLOUD_IMAP_HOST,
    port: ICLOUD_IMAP_PORT,
    secure: true,
    auth: { user, pass },
    logger: false,
  }) as unknown as AppendCapableFlow;
}

/** The Drafts-mailbox appender. `newFlow` is overridden in tests. */
export function createAppleDraftAppender(
  user: string,
  pass: string,
  newFlow: (user: string, pass: string) => AppendCapableFlow = realAppendFlow,
): DraftAppender {
  return new AppleDraftAppender(user, pass, newFlow);
}

// ---------------------------------------------------------------------------
// CalDavClient — tsdav DAVClient (two-phase: bootstrap discover then working)
//
// iCloud CalDAV authenticates against caldav.icloud.com but redirects to a
// user-specific host (p##-caldav.icloud.com). login() resolves the principal +
// calendar-home-set and binds the credentials to the resolved host so that
// Basic auth is applied on every subsequent request — without relying on
// transparent cross-host redirect forwarding.
// ---------------------------------------------------------------------------

/** The subset of tsdav's `DAVClient` this adapter drives. Faked in tests. */
export interface DavClientLike {
  login(): Promise<unknown>;
  fetchCalendars(): Promise<DAVCalendar[]>;
  fetchCalendarObjects(params: {
    calendar: DAVCalendar;
    timeRange?: { start: string; end: string };
    expand?: boolean;
  }): Promise<{ url: string; data?: unknown }[]>;
  createCalendarObject(params: {
    calendar: DAVCalendar;
    iCalString: string;
    filename: string;
  }): Promise<unknown>;
  deleteCalendarObject(params: { calendarObject: { url: string; etag: string } }): Promise<unknown>;
}

/** A CalDAV client with the login step the iCloud redirect dance requires. */
export interface LoggingInCalDavClient extends CalDavClient {
  login(): Promise<void>;
}

class TsdavCalDavClient implements LoggingInCalDavClient {
  /**
   * Discovered DAVCalendar objects keyed by their url. Populated after the
   * first listCalendars() call so that putEvent/listEvents can obtain the
   * full DAVCalendar object (which carries the account reference that tsdav
   * needs for auth on the resolved p##-caldav.icloud.com host).
   */
  private discovered: Map<string, DAVCalendar> = new Map();

  constructor(private readonly davClient: DavClientLike) {}

  async login(): Promise<void> {
    await this.davClient.login();
  }

  async listCalendars(): Promise<CalendarRef[]> {
    const cals = await this.davClient.fetchCalendars();
    // Refresh the discovery cache.
    this.discovered = new Map();
    for (const cal of cals) {
      this.discovered.set(cal.url, cal);
    }
    return cals.map((cal) => ({
      url: cal.url,
      displayName:
        typeof cal.displayName === "string" && cal.displayName !== "" ? cal.displayName : cal.url,
    }));
  }

  /**
   * Resolve a CalendarRef to the underlying DAVCalendar tsdav needs.
   * If not found in cache, constructs a minimal DAVCalendar using just the url
   * (tsdav fetchCalendarObjects only strictly requires `calendar.url`).
   */
  private toDavCalendar(cal: CalendarRef): DAVCalendar {
    return this.discovered.get(cal.url) ?? { url: cal.url };
  }

  async listEvents(
    cal: CalendarRef,
    window: EventWindow,
  ): Promise<{ href: string; event: ParsedEvent }[]> {
    const objects = await this.davClient.fetchCalendarObjects({
      calendar: this.toDavCalendar(cal),
      timeRange: { start: window.startUtc, end: window.endUtc },
      // expand: true triggers server-side recurrence expansion (C:expand in
      // the REPORT) — required per spec; no client-side RRULE engine.
      expand: true,
    });

    const results: { href: string; event: ParsedEvent }[] = [];
    for (const obj of objects) {
      if (typeof obj.data !== "string" || obj.data === "") {
        continue;
      }
      for (const event of parseICalendar(obj.data)) {
        results.push({ href: obj.url, event });
      }
    }
    return results;
  }

  async putEvent(cal: CalendarRef, uid: string, ics: string): Promise<{ href: string }> {
    // The UID is embedded into the object URL path segment; sanitize it so a
    // summary-derived UID with `/`, `#`, `%`, etc. cannot corrupt the href.
    const filename = caldavObjectFilename(uid);
    await this.davClient.createCalendarObject({
      calendar: this.toDavCalendar(cal),
      iCalString: ics,
      filename,
    });
    // The href of the newly created object is conventionally the calendar URL
    // joined with the filename. tsdav does not return a Location header
    // wrapper, so we construct it from the calendar URL.
    const href = cal.url.endsWith("/") ? `${cal.url}${filename}` : `${cal.url}/${filename}`;
    return { href };
  }

  async deleteEvent(href: string): Promise<void> {
    // etag: "" means "unconditional delete" — acceptable because we don't track
    // etags in the CalendarRef/EventWindow flow.
    await this.davClient.deleteCalendarObject({
      calendarObject: { url: href, etag: "" },
    });
  }
}

function realDavClient(email: string, appPw: string): DavClientLike {
  // login() performs principal + calendar-home discovery and binds the
  // credentials to all subsequent requests against the resolved
  // p##-caldav.icloud.com host — satisfying the auth-on-redirect requirement.
  return new DAVClient({
    serverUrl: ICLOUD_CALDAV_BOOTSTRAP_URL,
    credentials: { username: email, password: appPw },
    authMethod: "Basic",
    defaultAccountType: "caldav",
  }) as unknown as DavClientLike;
}

/** The iCloud CalDAV client. `makeDavClient` is overridden in tests. */
export function createAppleCalDavClient(
  email: string,
  appPw: string,
  makeDavClient: (email: string, appPw: string) => DavClientLike = realDavClient,
): LoggingInCalDavClient {
  return new TsdavCalDavClient(makeDavClient(email, appPw));
}

/**
 * iCalendar DTSTAMP format (RFC 5545): `YYYYMMDDTHHMMSSZ`.
 *
 * `buildVEvent` emits the value verbatim, so it must NOT be ISO-8601 — no
 * hyphens, colons or milliseconds.
 */
export function icalTimestamp(at: Date = new Date()): string {
  return at
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z");
}
