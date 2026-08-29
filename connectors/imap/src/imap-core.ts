/**
 * IMAP/SMTP connector core — transport-agnostic logic for the read tools
 * (`imap_list`, `imap_get`, `imap_search`) and the HITL-gated send tool
 * (`imap_mail_send`).
 *
 * HARD SCOPE CONSTRAINT (security): this connector indexes HEADERS + a short
 * capped plain-text body PREVIEW + attachment METADATA only. It NEVER downloads
 * or parses attachment bytes and never fetches the full message body. The IMAP
 * client interface below deliberately exposes only `envelope` + `bodyStructure`
 * (headers / attachment metadata) and a single truncated text body part for the
 * preview — there is no surface to request `BODY[]` or an attachment part.
 *
 * The IMAP client and SMTP mailer are injected so tests never open real sockets.
 *
 * The shapes themselves now live in `shared/imap-mail-core.ts`: this connector
 * and protonmail declared them separately and identically, which is the same
 * duplication the tool layer had already been through. The `Imap*` aliases stay
 * so this connector's own callers read as before.
 */

import type {
  MailAddress,
  MailAttachmentMeta,
  MailClient,
  MailEnvelope,
  MailListOptions,
  MailMessageMeta,
  MailSearchOptions,
} from "../../../shared/imap-mail-core.ts";

export type {
  SendMailInput,
  SendMailResult,
  SmtpMailer,
} from "../../../shared/imap-mail-core.ts";
export {
  capPreview,
  clampLimit,
  formatAddress,
  PREVIEW_FETCH_BYTES,
  PREVIEW_MAX_CHARS,
} from "../../../shared/imap-mail-core.ts";

/** One parsed address (name optional). */
export type ImapAddress = MailAddress;
/** Message ENVELOPE — RFC 2822 header fields only. */
export type ImapEnvelope = MailEnvelope;
/** Attachment METADATA only — filename, size, mimetype. NEVER the bytes. */
export type ImapAttachmentMeta = MailAttachmentMeta;
/** Header + attachment-metadata + capped preview: the only shape materialized. */
export type ImapMessageMeta = MailMessageMeta;
/** Listing options. */
export type ImapListOptions = MailListOptions;
/** Search options — header/envelope fields only, never body-content scans. */
export type ImapSearchOptions = MailSearchOptions;
/** Minimal IMAP client surface the connector depends on. */
export type ImapClient = MailClient;
