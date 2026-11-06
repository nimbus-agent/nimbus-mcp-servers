/**
 * guarded-fetch — a `fetch` that never lets a redirect carry a credential to another origin.
 *
 * A runtime follows a 3xx by default, and the Fetch spec strips only the `Authorization` header on
 * a cross-origin hop: a custom credential header (GitLab's `PRIVATE-TOKEN`) goes along to whatever
 * `Location` names. So every credentialed request here asks for `redirect: "manual"` and decides
 * itself:
 *
 * - a redirect on a mutation (anything but GET/HEAD) is refused: replaying a write is not ours to
 *   decide, and the credential must not follow it;
 * - a redirect on a GET/HEAD is followed (at most {@link MAX_REDIRECT_HOPS} times) only when the
 *   `Location` resolves to the SAME origin as the request, over https (or a loopback http origin,
 *   for a local fake server); any other target is refused and nothing is sent there;
 * - a request to a plain-http origin that is not loopback is refused before it is sent, since it
 *   would put the credential on the wire in clear.
 */

import { fetchWithTimeout } from "@nimbus-dev/sdk/connector-kit";

/** Followed redirects allowed on one GET/HEAD; the next one is refused. */
export const MAX_REDIRECT_HOPS = 3;

/** Per-request timeout when the caller supplies no transport; the SDK's default for every connector. */
const DEFAULT_TIMEOUT_MS = 15_000;

const REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);

function isLoopbackHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

/** Throws unless `url` is https, or http to a loopback host. */
function assertSecureTransport(label: string, url: URL): void {
  if (url.protocol === "https:") return;
  if (url.protocol === "http:" && isLoopbackHost(url.hostname)) return;
  throw new Error(`${label} base URL must be https (or loopback http); refused`);
}

export interface GuardedFetchOptions {
  /** The transport to use. Defaults to the SDK's `fetchWithTimeout` (15 s per request, per hop). */
  readonly fetch?: (url: string, init: RequestInit) => Promise<Response>;
  /**
   * Refuse a first request to a plain-http, non-loopback origin. Defaults to true. The JSON GET
   * client turns it off: its callers have always been allowed a self-hosted http base, so only
   * what a redirect points at is the new decision.
   */
  readonly requireSecureBase?: boolean;
}

/**
 * `fetch(url, init)` with the redirect policy above. `label` names the service in a refusal
 * ("GitLab redirected a POST; refused"). Resolves to the final non-redirect response.
 */
export async function guardedFetch(
  label: string,
  url: string,
  init: RequestInit = {},
  options: GuardedFetchOptions = {},
): Promise<Response> {
  const method = (init.method ?? "GET").toUpperCase();
  const mayFollow = method === "GET" || method === "HEAD";
  const doFetch =
    options.fetch ?? ((u: string, i: RequestInit) => fetchWithTimeout(u, i, DEFAULT_TIMEOUT_MS));
  let current = new URL(url);
  if (options.requireSecureBase !== false) assertSecureTransport(label, current);
  for (let hop = 0; ; hop += 1) {
    const res = await doFetch(current.toString(), { ...init, redirect: "manual" });
    if (!REDIRECT_STATUSES.has(res.status)) return res;
    if (!mayFollow) {
      throw new Error(`${label} redirected a ${method}; refused`);
    }
    const location = res.headers.get("location");
    if (location === null || location === "") {
      throw new Error(`${label} sent a redirect without a Location; refused`);
    }
    if (hop >= MAX_REDIRECT_HOPS) {
      throw new Error(`${label} sent too many redirects; refused`);
    }
    let next: URL;
    try {
      next = new URL(location, current);
    } catch {
      throw new Error(`${label} redirected to an invalid URL; refused`);
    }
    const sameOrigin = next.origin === current.origin;
    const secure = next.protocol === "https:" || isLoopbackHost(next.hostname);
    if (!sameOrigin || !secure) {
      throw new Error(`${label} redirected to another origin; refused`);
    }
    current = next;
  }
}
