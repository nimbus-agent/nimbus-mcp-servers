/**
 * guarded-bearer-json — `fetchBearerAuthorizedJson` (the SDK's Bearer-auth JSON fetch) over
 * `guardedFetch`.
 *
 * The SDK's helper calls `fetch` with no `redirect` option and no timeout, so a 3xx re-sent the
 * Bearer token wherever `Location` pointed and a hung host held the tool call open forever. This one
 * has the same inputs and the same `{ ok, status, json, text }` result, and differs only in what a
 * redirect and a stall do: a write's 3xx is refused, a read follows only a same-origin Location, and
 * every request times out.
 *
 * It does NOT resolve a path against a base: callers keep using `resolveUrlWithBase` for that, which
 * is what stops a model-supplied next-page link from naming another host in the first place.
 */

import { type GuardedFetchOptions, guardedFetch } from "./guarded-fetch.ts";

export interface GuardedBearerJsonResult {
  readonly ok: boolean;
  readonly status: number;
  readonly json: unknown;
  readonly text: string;
}

/**
 * Same merge rule as the SDK helper: `Authorization: Bearer <token>`, then `defaultHeaders`, then
 * any header in `init.headers` overriding both (case-insensitively).
 */
export async function guardedBearerJson(
  label: string,
  url: string,
  token: string,
  init?: RequestInit,
  defaultHeaders?: Record<string, string>,
  options?: GuardedFetchOptions,
): Promise<GuardedBearerJsonResult> {
  const headers = new Headers({ Authorization: `Bearer ${token}`, ...defaultHeaders });
  if (init?.headers !== undefined) {
    for (const [name, value] of new Headers(init.headers)) {
      headers.set(name, value);
    }
  }
  const res = await guardedFetch(label, url, { ...init, headers }, options);
  const text = await res.text();
  let json: unknown;
  try {
    json = JSON.parse(text) as unknown;
  } catch {
    json = null;
  }
  return { ok: res.ok, status: res.status, json, text };
}
