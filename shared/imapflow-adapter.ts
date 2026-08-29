/**
 * imapflow-adapter — the real IMAP client + SMTP mailer over `imapflow` and
 * `nodemailer`, shared by every IMAP-based mail connector (imap, protonmail).
 *
 * These two class bodies were previously written out in full in each
 * connector's `server.ts`. `imap-tool-kit.ts` deliberately left them alone at
 * the time ("class bodies … are out of scope per the dedup brief"), and the
 * cost of that was measurable on both axes Sonar reports:
 *
 *   - duplication: `imap/src/server.ts` 41.2% and `protonmail/src/server.ts`
 *     38.8%, 186 duplicated lines between them — the largest pair in the repo;
 *   - coverage: both files were 0%. An entry point that constructs its adapters
 *     at module scope cannot be imported by a test without opening real
 *     sockets, so every line of transport logic in them was unasserted.
 *
 * Extracting the classes here fixes both: one copy, and one that a test can
 * construct because the `imapflow` client and the `nodemailer` transport are
 * injected seams rather than direct `new` calls. The two connectors differ only
 * in configuration (TLS mode, ports, env var names, mailbox default), so all of
 * it is passed in.
 *
 * HARD SCOPE CONSTRAINT (security), inherited from both connectors: the fetch
 * query below requests ONLY `envelope` + `bodyStructure` + a `PREVIEW_FETCH_BYTES`-
 * capped text part. There is no surface here to request `BODY[]` or an
 * attachment part, so no caller can make this adapter download message bodies
 * or attachment bytes.
 */

import { type FetchMessageObject, type FetchQueryObject, ImapFlow } from "imapflow";
import { createTransport, type Transporter } from "nodemailer";
import {
  type BodyStructureNode,
  extractAttachments,
  findTextPlainPart,
} from "./imap-bodystructure.ts";
import { clampLimit, type MailAddress, PREVIEW_FETCH_BYTES } from "./imap-mail-core.ts";
import {
  type EmailMessageMeta,
  type EmailReadClient,
  type EmailSendMailer,
  previewFromParts,
} from "./imap-tool-kit.ts";

/** Mailbox used when a tool call does not name one. */
export const DEFAULT_MAILBOX = "INBOX";

/** Connection settings for one IMAP endpoint. Read from `process.env` by the caller. */
export interface ImapEndpointConfig {
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly pass: string;
  /**
   * Implicit TLS on connect. `true` for a normal IMAPS endpoint on 993; `false`
   * for the ProtonMail Bridge, which speaks STARTTLS on loopback.
   */
  readonly secure: boolean;
  /**
   * Chain verification. Omit (the default) for a real endpoint. Only the
   * ProtonMail Bridge passes `false`, for its self-signed loopback certificate;
   * the connection never leaves 127.0.0.1.
   */
  readonly rejectUnauthorized?: boolean;
  /** Mailbox used when a call does not name one. Defaults to {@link DEFAULT_MAILBOX}. */
  readonly defaultMailbox?: string;
}

/** Connection settings for one SMTP endpoint. */
export interface SmtpEndpointConfig {
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly pass: string;
  readonly secure: boolean;
  readonly rejectUnauthorized?: boolean;
  /**
   * Refuse to send at all if the server does not advertise STARTTLS.
   *
   * Only meaningful with `secure: false`. **Defaults to `true` there**, which is
   * the safe default rather than nodemailer's: without it nodemailer falls back
   * to plaintext when the server does not advertise STARTTLS, and the SMTP
   * password goes out in the clear.
   *
   * That was a live gap, not a hypothetical one. `imap` computes
   * `secure: port === 465`, so an operator setting `IMAP_SMTP_PORT=587` — the
   * standard submission port — got `secure: false` and no `requireTLS`. Apple's
   * copy of this mailer was the only one of the three that set it.
   *
   * Pass `false` only for an endpoint that genuinely cannot offer STARTTLS, and
   * only where the connection cannot leave the host.
   */
  readonly requireTLS?: boolean;
}

/** Constructs the `imapflow` client. Overridden in tests so no socket is opened. */
export type ImapFlowFactory = (options: ConstructorParameters<typeof ImapFlow>[0]) => ImapFlow;

/**
 * The transport options this adapter builds. Declared here rather than reused
 * from nodemailer: `Parameters<typeof createTransport>[0]` resolves to the
 * union `Transport | TransportOptions`, and a plain SMTP option literal is not
 * assignable to that union.
 */
export interface SmtpTransportOptions {
  readonly host: string;
  readonly port: number;
  readonly secure: boolean;
  readonly auth: { readonly user: string; readonly pass: string };
  /** Always set by this module: `true` whenever `secure` is false. */
  readonly requireTLS: boolean;
  readonly tls?: { readonly rejectUnauthorized: boolean };
}

/** Constructs the `nodemailer` transport. Overridden in tests so no socket is opened. */
export type TransportFactory = (options: SmtpTransportOptions) => Transporter;

/**
 * Build a {@link MailAddress} from an imapflow envelope address, omitting
 * `name`/`address` when absent — the interface uses `exactOptionalPropertyTypes`,
 * so an explicit `undefined` is not assignable.
 */
function toMailAddress(a: { name?: string; address?: string }): MailAddress {
  const out: { name?: string; address?: string } = {};
  if (a.name !== undefined) {
    out.name = a.name;
  }
  if (a.address !== undefined) {
    out.address = a.address;
  }
  return out;
}

function envelopeFromImap(env: FetchMessageObject["envelope"]): EmailMessageMeta["envelope"] {
  if (env === undefined) {
    return {};
  }
  return {
    date: env.date ?? null,
    subject: env.subject ?? null,
    messageId: env.messageId ?? null,
    from: (env.from ?? []).map(toMailAddress),
    to: (env.to ?? []).map(toMailAddress),
    cc: (env.cc ?? []).map(toMailAddress),
  };
}

/** Reduce one fetched message to the header + attachment-metadata + preview view. */
export function toMessageMeta(
  msg: FetchMessageObject,
  mailbox: string,
  uidValidity: string | null,
): EmailMessageMeta {
  const structure = (msg.bodyStructure ?? null) as BodyStructureNode | null;
  const partKey = findTextPlainPart(structure);
  return {
    uid: msg.uid,
    mailbox,
    uidValidity,
    envelope: envelopeFromImap(msg.envelope),
    attachments: extractAttachments(structure),
    preview: previewFromParts(msg.bodyParts, partKey),
  };
}

/**
 * Fetch query that requests ONLY headers + structure + a truncated text body
 * part. There is no `source` / full-body request here by construction.
 */
export function previewFetchQuery(): FetchQueryObject {
  return {
    uid: true,
    envelope: true,
    bodyStructure: true,
    internalDate: true,
    // Two candidate text part keys, each capped to PREVIEW_FETCH_BYTES bytes.
    bodyParts: [
      { key: "1", start: 0, maxLength: PREVIEW_FETCH_BYTES },
      { key: "TEXT", start: 0, maxLength: PREVIEW_FETCH_BYTES },
    ],
  };
}

/**
 * Real IMAP client over imapflow. Per-call connect/lock/logout keeps it
 * stateless, so nothing is held open between tool calls.
 */
class ImapFlowClient implements EmailReadClient {
  private readonly defaultMailbox: string;

  constructor(
    private readonly config: ImapEndpointConfig,
    private readonly newImapFlow: ImapFlowFactory,
  ) {
    this.defaultMailbox = config.defaultMailbox ?? DEFAULT_MAILBOX;
  }

  private newClient(): ImapFlow {
    const { host, port, secure, user, pass, rejectUnauthorized } = this.config;
    return this.newImapFlow({
      host,
      port,
      secure,
      auth: { user, pass },
      logger: false,
      // Only set when the caller asked to relax it — see ImapEndpointConfig.
      ...(rejectUnauthorized === undefined ? {} : { tls: { rejectUnauthorized } }),
    });
  }

  private async withMailbox<T>(
    mailbox: string,
    fn: (client: ImapFlow, uidValidity: string | null) => Promise<T>,
  ): Promise<T> {
    const client = this.newClient();
    await client.connect();
    // `logout` sits in an OUTER finally so the connection is closed even when
    // `getMailboxLock` throws. Acquiring the lock BEFORE the try — which is how
    // imap and protonmail both had it — leaks the connected socket on a locking
    // failure (a mailbox that does not exist, or one another client holds), and
    // this client connects per call, so every such failure leaks another.
    // Apple's copy already nested it this way; the correction travelled the
    // wrong direction when these were three separate copies.
    try {
      const lock = await client.getMailboxLock(mailbox);
      try {
        const mb = client.mailbox;
        const uidValidity = mb === false ? null : String(mb.uidValidity);
        return await fn(client, uidValidity);
      } finally {
        lock.release();
      }
    } finally {
      await client.logout();
    }
  }

  async list(options: { mailbox?: string; limit?: number }): Promise<EmailMessageMeta[]> {
    const mailbox = options.mailbox ?? this.defaultMailbox;
    const limit = clampLimit(options.limit);
    return this.withMailbox(mailbox, async (client, uidValidity) => {
      const out: EmailMessageMeta[] = [];
      const status = await client.status(mailbox, { messages: true });
      const total = status.messages ?? 0;
      if (total === 0) {
        return out;
      }
      const start = Math.max(1, total - limit + 1);
      const range = `${start}:${total}`;
      for await (const msg of client.fetch(range, previewFetchQuery())) {
        out.push(toMessageMeta(msg, mailbox, uidValidity));
      }
      // Most-recent first.
      out.sort((a, b) => b.uid - a.uid);
      return out;
    });
  }

  async get(uid: number, mailbox?: string): Promise<EmailMessageMeta | null> {
    const box = mailbox ?? this.defaultMailbox;
    return this.withMailbox(box, async (client, uidValidity) => {
      const msg = await client.fetchOne(String(uid), previewFetchQuery(), { uid: true });
      return msg === false ? null : toMessageMeta(msg, box, uidValidity);
    });
  }

  async search(options: {
    query: string;
    mailbox?: string;
    limit?: number;
  }): Promise<EmailMessageMeta[]> {
    const mailbox = options.mailbox ?? this.defaultMailbox;
    const limit = clampLimit(options.limit);
    const q = options.query;
    return this.withMailbox(mailbox, async (client, uidValidity) => {
      const uids = await client.search(
        { or: [{ subject: q }, { from: q }, { to: q }] },
        { uid: true },
      );
      if (uids === false || uids.length === 0) {
        return [];
      }
      const picked = uids.slice(-limit).sort((a, b) => b - a);
      const out: EmailMessageMeta[] = [];
      for await (const msg of client.fetch(picked, previewFetchQuery(), { uid: true })) {
        out.push(toMessageMeta(msg, mailbox, uidValidity));
      }
      out.sort((a, b) => b.uid - a.uid);
      return out;
    });
  }
}

/**
 * Real SMTP mailer over nodemailer.
 *
 * The envelope `from` is PINNED to the authenticated user and is not a `send`
 * parameter, so no caller can send as someone else (the forced-sender contract
 * the mail connectors document).
 */
class NodemailerMailer implements EmailSendMailer {
  private readonly transport: Transporter;
  private readonly from: string;

  constructor(config: SmtpEndpointConfig, makeTransport: TransportFactory) {
    const { host, port, secure, user, pass, rejectUnauthorized } = config;
    this.from = user;
    this.transport = makeTransport({
      host,
      port,
      secure,
      auth: { user, pass },
      // Implicit TLS already encrypts the session; otherwise STARTTLS is
      // REQUIRED unless the caller has explicitly opted out. There is no
      // configuration of this mailer that sends credentials in the clear by
      // omission.
      requireTLS: secure ? false : (config.requireTLS ?? true),
      ...(rejectUnauthorized === undefined ? {} : { tls: { rejectUnauthorized } }),
    });
  }

  async send(input: {
    to: string;
    subject: string;
    body: string;
    cc?: string;
    bcc?: string;
  }): Promise<{
    messageId: string | null;
    accepted: readonly string[];
    rejected: readonly string[];
  }> {
    const info = await this.transport.sendMail({
      from: this.from,
      to: input.to,
      subject: input.subject,
      text: input.body,
      ...(input.cc === undefined ? {} : { cc: input.cc }),
      ...(input.bcc === undefined ? {} : { bcc: input.bcc }),
    });
    return {
      messageId: info.messageId ?? null,
      accepted: (info.accepted ?? []).map(String),
      rejected: (info.rejected ?? []).map(String),
    };
  }
}

/**
 * The IMAP read client for `config`. `newImapFlow` defaults to the real
 * `imapflow` constructor; tests pass a fake so no socket is opened.
 */
export function createImapFlowClient(
  config: ImapEndpointConfig,
  newImapFlow: ImapFlowFactory = (options) => new ImapFlow(options),
): EmailReadClient {
  return new ImapFlowClient(config, newImapFlow);
}

/**
 * The SMTP mailer for `config`. `makeTransport` defaults to nodemailer's
 * `createTransport`; tests pass a fake so no socket is opened.
 */
export function createNodemailerMailer(
  config: SmtpEndpointConfig,
  makeTransport: TransportFactory = (options) => createTransport(options),
): EmailSendMailer {
  return new NodemailerMailer(config, makeTransport);
}
