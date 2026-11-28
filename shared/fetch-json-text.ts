/**
 * fetch-json-text — send a JSON API request and hand back the raw response text.
 *
 * `atlassian-json-fetch.ts` (jira, confluence) and notion built this request the same way around
 * different credentials: their own headers first, `Content-Type: application/json` only when the
 * request has a body, and any header the caller passes in `init` overriding all of them. A non-2xx
 * is reported rather than thrown, because these APIs put the useful diagnostic in the error body.
 *
 * The request goes through `guardedFetch`: a redirect on a write is refused, a read follows only a
 * same-origin (or same-host http -> https) one, and every hop has the SDK's request timeout. The
 * base URL may be plain http, as a self-hosted Atlassian site always could be.
 */

import { guardedFetch } from "./guarded-fetch.ts";

export async function fetchJsonText(
  url: string,
  baseHeaders: Readonly<Record<string, string>>,
  init?: RequestInit,
  /** Service name that prefixes a refused redirect ("Notion answered a POST with a redirect"). */
  label = "Request",
): Promise<{ ok: boolean; status: number; text: string }> {
  const headers: Record<string, string> = { ...baseHeaders };
  if (init?.body !== undefined) {
    headers["Content-Type"] = "application/json";
  }
  const res = await guardedFetch(
    label,
    url,
    {
      ...init,
      headers: {
        ...headers,
        ...(init?.headers as Record<string, string> | undefined),
      },
    },
    { requireSecureBase: false },
  );
  const text = await res.text();
  return { ok: res.ok, status: res.status, text };
}
