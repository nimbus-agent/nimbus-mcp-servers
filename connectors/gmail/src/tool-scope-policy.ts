/**
 * Which Gmail tools need an OAuth scope beyond the connector's default grant, and whether the token
 * the gateway passes holds it. The gateway sets `GOOGLE_OAUTH_SCOPES` (space-separated, the full
 * scope URIs Google returns) from the `google.oauth` Vault entry.
 *
 * Unlike Outlook's policy, an ABSENT env does NOT register a scope-gated tool: a gateway that does
 * not pass scopes (every gateway before the one that pins this release) never lists a write its
 * token cannot perform. Every tool without an entry below registers as before.
 */
const GMAIL_MODIFY = "https://www.googleapis.com/auth/gmail.modify";
/** The full-mailbox scope, a superset of `gmail.modify`. */
const GMAIL_FULL = "https://mail.google.com/";

const GMAIL_TOOL_MIN_SCOPES: Readonly<Record<string, readonly string[]>> = {
  gmail_thread_archive: [GMAIL_MODIFY],
};

function scopeSatisfied(granted: ReadonlySet<string>, required: string): boolean {
  if (granted.has(required)) return true;
  return required === GMAIL_MODIFY && granted.has(GMAIL_FULL);
}

/** The scopes in `GOOGLE_OAUTH_SCOPES`, or `undefined` when it is unset or blank. */
export function parseGoogleOAuthScopesFromEnv(): string[] | undefined {
  const raw = process.env["GOOGLE_OAUTH_SCOPES"];
  if (raw === undefined) return undefined;
  const parts = raw.split(/\s+/).filter((s) => s.length > 0);
  return parts.length === 0 ? undefined : parts;
}

/** Whether `toolId` registers for a token holding `granted` (`undefined`: scopes unknown). */
export function gmailToolShouldRegister(toolId: string, granted: string[] | undefined): boolean {
  const reqs = GMAIL_TOOL_MIN_SCOPES[toolId];
  if (reqs === undefined) return true;
  if (granted === undefined) return false;
  const g = new Set(granted);
  return reqs.every((r) => scopeSatisfied(g, r));
}
