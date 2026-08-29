/**
 * Pure, transport-agnostic helpers shared by the IMAP-based mail connectors
 * (imap, protonmail-via-Bridge). ProtonMail Bridge exposes a standard IMAP/SMTP
 * interface, so both connectors share the same preview-capping, limit-clamping,
 * and address-formatting logic. No external deps; never touches message bodies
 * or attachment bytes.
 */

/** Max characters of the plain-text body preview that is ever indexed/returned. */
export const PREVIEW_MAX_CHARS = 2000;
/** Max bytes of the text/plain body part fetched for the preview (~2 KB). */
export const PREVIEW_FETCH_BYTES = 2048;

/** One parsed address (name optional). */
export interface MailAddress {
  readonly name?: string;
  readonly address?: string;
}

const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 200;

export function clampLimit(limit: number | undefined, fallback = DEFAULT_LIST_LIMIT): number {
  if (limit === undefined || !Number.isFinite(limit)) {
    return fallback;
  }
  const n = Math.trunc(limit);
  if (n < 1) {
    return 1;
  }
  return Math.min(n, MAX_LIST_LIMIT);
}

/**
 * Cap a body preview to {@link PREVIEW_MAX_CHARS}. Normalizes CRLF and collapses
 * whitespace/blank-line runs so the preview stays compact; never lengthens the
 * input.
 */
export function capPreview(text: string): string {
  const normalized = text
    .replaceAll("\r\n", "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{2,}/g, "\n")
    .trim();
  return normalized.length > PREVIEW_MAX_CHARS
    ? normalized.slice(0, PREVIEW_MAX_CHARS)
    : normalized;
}

/** Format one address as `Name <addr>` / `<addr>` for envelope display. */
export function formatAddress(a: MailAddress): string {
  const addr = a.address ?? "";
  if (a.name !== undefined && a.name !== "") {
    return addr === "" ? a.name : `${a.name} <${addr}>`;
  }
  return addr;
}

/**
 * Message ENVELOPE — RFC 2822 header fields only.
 *
 * These five declarations were written out identically in `imap/src/imap-core.ts`
 * and `protonmail/src/mail-core.ts`, differing only in the `Imap`/`Mail` name
 * prefix. Both connectors index the same thing through the same protocol, so
 * there was never a second shape here — only a second copy. Each core now
 * aliases these, keeping its own names for its own callers.
 */
export interface MailEnvelope {
  readonly date?: Date | string | null;
  readonly subject?: string | null;
  readonly messageId?: string | null;
  readonly from?: readonly MailAddress[];
  readonly to?: readonly MailAddress[];
  readonly cc?: readonly MailAddress[];
}

/**
 * Attachment METADATA only — filename, size, mimetype. NEVER the bytes.
 * Derived from BODYSTRUCTURE.
 */
export interface MailAttachmentMeta {
  readonly filename: string | null;
  readonly sizeBytes: number | null;
  readonly mimeType: string | null;
}

/**
 * A single mailbox message reduced to header + attachment-metadata + a capped
 * text preview. This is the ONLY shape these connectors ever materialize; it
 * has no field that could carry attachment content or a full body.
 */
export interface MailMessageMeta {
  readonly uid: number;
  readonly mailbox: string;
  readonly uidValidity: string | null;
  readonly envelope: MailEnvelope;
  readonly attachments: readonly MailAttachmentMeta[];
  /** Plain-text body preview, already capped to {@link PREVIEW_MAX_CHARS}. */
  readonly preview: string;
}

/** Listing options. */
export interface MailListOptions {
  readonly mailbox?: string;
  readonly limit?: number;
}

/** Search options — searches header/envelope fields, never body-content scans. */
export interface MailSearchOptions {
  readonly query: string;
  readonly mailbox?: string;
  readonly limit?: number;
}

/**
 * Minimal IMAP client surface these connectors depend on. Implemented for real
 * by `shared/imapflow-adapter.ts` and by a fake in tests. Deliberately exposes
 * ONLY header/attachment-metadata + capped-preview reads.
 */
export interface MailClient {
  /** List the most recent messages (header + attachment metadata + preview). */
  list(options: MailListOptions): Promise<MailMessageMeta[]>;
  /** Fetch one message's header + attachment metadata + preview by uid. */
  get(uid: number, mailbox?: string): Promise<MailMessageMeta | null>;
  /** Search by subject/from/to substring; returns matching message metas. */
  search(options: MailSearchOptions): Promise<MailMessageMeta[]>;
}

/** Outgoing message for the SMTP send tool. */
export interface SendMailInput {
  readonly to: string;
  readonly subject: string;
  readonly body: string;
  readonly cc?: string;
  readonly bcc?: string;
}

/** Result of a send (message id assigned by the SMTP server, if any). */
export interface SendMailResult {
  readonly messageId: string | null;
  readonly accepted: readonly string[];
  readonly rejected: readonly string[];
}

/** Minimal SMTP mailer surface; implemented for real over nodemailer. */
export interface SmtpMailer {
  send(input: SendMailInput): Promise<SendMailResult>;
}
