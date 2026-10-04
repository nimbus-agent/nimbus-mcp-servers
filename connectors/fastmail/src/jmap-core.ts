/**
 * JMAP connector core — transport-agnostic logic for the Fastmail read tools
 * (`fastmail_list`, `fastmail_get`, `fastmail_search`) and the HITL-gated send
 * tool (`fastmail_mail_send`).
 *
 * HARD SCOPE CONSTRAINT (security): this connector indexes/returns HEADERS + a
 * short capped plain-text body PREVIEW + attachment METADATA only. The JMAP
 * `Email/get` calls request `maxBodyValueBytes` (the server truncates the body
 * value, so a full body never crosses the wire) and store only the `attachments`
 * body-part METADATA (name/size/type) — the `blobId` download URL is NEVER
 * dereferenced. There is no surface to fetch attachment bytes or a full body.
 *
 * The JMAP transport (real over `fetch`) is injected so tests never open a socket.
 *
 * Pure JMAP parsing and request-building is provided by `@nimbus-dev/sdk`
 * (gateway ↔ mcp boundary — neither package can import the other).
 */

import type { JmapEmailView } from "@nimbus-dev/sdk";
import type { OutgoingMail } from "../../../shared/imap-tool-kit.ts";

export {
  asRecord,
  asString,
  buildGetRequest,
  buildListRequest,
  buildSearchRequest,
  CORE_CAPABILITY,
  capPreview,
  EMAIL_PROPERTIES,
  extractAttachments,
  extractEmailList,
  formatAddress,
  formatAddresses,
  type JmapAttachmentMeta,
  type JmapEmailView,
  type JmapSession,
  MAIL_CAPABILITY,
  MAX_BODY_VALUE_BYTES,
  methodResponseArgs,
  PREVIEW_MAX_CHARS,
  parseSession,
  previewFor,
  SUBMISSION_CAPABILITY,
  validateApiUrl,
  viewEmail,
} from "@nimbus-dev/sdk";

/**
 * The list/search limit clamp (default 50, ceiling 200) is the one every mail connector
 * applies; the tools' own schemas cap `limit` at the same 200.
 */
export { clampLimit } from "../../../shared/imap-mail-core.ts";

/** Outgoing message for the JMAP submission send tool — the shared mail-send shape. */
export type SendMailInput = OutgoingMail;

export interface SendMailResult {
  readonly emailId: string | null;
  readonly submissionId: string | null;
}

/**
 * Minimal Fastmail/JMAP client surface the tools depend on. Implemented for real
 * by the fetch adapter in `server.ts` and by a fake in tests. Deliberately
 * exposes ONLY header/attachment-metadata + capped-preview reads + a send.
 */
export interface JmapClient {
  list(limit: number): Promise<JmapEmailView[]>;
  get(id: string): Promise<JmapEmailView | null>;
  search(query: string, limit: number): Promise<JmapEmailView[]>;
  send(input: SendMailInput): Promise<SendMailResult>;
}
