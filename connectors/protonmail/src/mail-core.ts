/**
 * ProtonMail (via ProtonMail Bridge) connector core — transport-agnostic logic
 * for the read tools (`protonmail_list`, `protonmail_get`, `protonmail_search`)
 * and the HITL-gated send tool (`protonmail_mail_send`). ProtonMail Bridge
 * exposes a standard IMAP/SMTP interface on the loopback interface, so this is
 * the same shape as the generic IMAP connector core.
 *
 * HARD SCOPE CONSTRAINT (security): this connector indexes HEADERS + a short
 * capped plain-text body PREVIEW + attachment METADATA only. It NEVER downloads
 * or parses attachment bytes and never fetches the full message body.
 *
 * The IMAP client and SMTP mailer are injected so tests never open real sockets.
 *
 * "The same shape as the generic IMAP connector core" used to be a comment
 * above a second copy of that shape. It is now a re-export of it, from
 * `shared/imap-mail-core.ts`.
 */

export type {
  MailAddress,
  MailAttachmentMeta,
  MailClient,
  MailEnvelope,
  MailListOptions,
  MailMessageMeta,
  MailSearchOptions,
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
