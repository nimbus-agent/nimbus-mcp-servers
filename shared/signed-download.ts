/**
 * signed-download — a credentialed GET whose bytes may live on another origin.
 *
 * Some download endpoints (Microsoft Graph `/content`, Google Drive `alt=media`) answer with a 302
 * to a pre-authenticated storage URL on a different host. The credential must never go there, and
 * the download must still work. So this does what `guardedFetch` does for the API origin
 * (`redirect: "manual"`, a same-origin or same-host http -> https redirect is followed with the
 * credential, at most {@link MAX_REDIRECT_HOPS} times), and for the one thing `guardedFetch`
 * refuses, a cross-origin `Location`, it makes exactly ONE credential-free request:
 *
 * - the target must be https (a `file:`, `ftp:` or plain-http target is refused, nothing sent);
 * - it carries no headers at all, so no `Authorization` and nothing else of the caller's;
 * - it has the SDK's request timeout, and a further redirect from it is refused.
 *
 * The signed URL is the secret there, so it is never quoted in an error.
 */

import { fetchWithTimeout } from "@nimbus-dev/sdk/connector-kit";
import { isSameOriginOrUpgrade, MAX_REDIRECT_HOPS } from "./guarded-fetch.ts";

const REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);
const DEFAULT_TIMEOUT_MS = 15_000;

type Transport = (url: string, init: RequestInit) => Promise<Response>;

export interface SignedDownloadOptions {
  /** The transport for both requests. Defaults to the SDK's `fetchWithTimeout` (15 s). */
  readonly fetch?: Transport;
}

/** `fetch(url, init)` for a GET against an https API origin that may hand off to signed storage. */
export async function fetchWithSignedHandoff(
  label: string,
  url: string,
  init: RequestInit,
  options: SignedDownloadOptions = {},
): Promise<Response> {
  const doFetch: Transport =
    options.fetch ?? ((u, i) => fetchWithTimeout(u, i, DEFAULT_TIMEOUT_MS));
  let current = new URL(url);
  if (current.protocol !== "https:") {
    throw new Error(`${label} base URL must be https; refused`);
  }
  for (let hop = 0; ; hop += 1) {
    const res = await doFetch(current.toString(), { ...init, redirect: "manual" });
    if (!REDIRECT_STATUSES.has(res.status)) return res;
    const location = res.headers.get("location");
    if (location === null || location === "") {
      throw new Error(`${label} sent a redirect without a Location; refused`);
    }
    if (hop >= MAX_REDIRECT_HOPS) throw new Error(`${label} sent too many redirects; refused`);
    let next: URL;
    try {
      next = new URL(location, current);
    } catch {
      throw new Error(`${label} redirected to an invalid URL; refused`);
    }
    if (isSameOriginOrUpgrade(current, next)) {
      current = next;
      continue;
    }
    // Another origin: the credential stays behind. Only https storage, one hop, no headers.
    if (next.protocol !== "https:") {
      throw new Error(`${label} redirected the download to a ${next.protocol} URL; refused`);
    }
    const signed = await doFetch(next.toString(), { redirect: "manual" });
    if (REDIRECT_STATUSES.has(signed.status)) {
      throw new Error(`${label} download URL redirected again; refused`);
    }
    return signed;
  }
}
