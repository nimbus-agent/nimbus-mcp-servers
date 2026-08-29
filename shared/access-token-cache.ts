/**
 * access-token-cache — the "exchange credentials for a short-lived access
 * token, then reuse it" pattern.
 *
 * Three connectors reach an API that will not take their configured credential
 * directly: Ramp and Wiz exchange a client id/secret at an OAuth token
 * endpoint, Superset posts a username/password to its own `/security/login`.
 * All three then cache the result for the life of the process, and all three
 * had written out the same tail by hand —
 *
 *   POST → non-2xx? throw `<label> <status>: <body>` → JSON.parse, and throw a
 *   distinct error when the body is not JSON → reject a missing or empty
 *   `access_token` → cache → return
 *
 * — which is four failure modes each of which is easy to get subtly wrong, and
 * which Sonar flagged as duplicated between Ramp and Superset.
 *
 * The exchange REQUEST is not shared, only its result handling: an OAuth
 * client-credentials POST and a JSON login POST have genuinely different
 * bodies, headers and endpoints, and collapsing them would mean a config object
 * that is really two shapes in a trench coat.
 */

/** What a successful exchange yields. */
export interface AccessTokenResponse {
  readonly ok: boolean;
  readonly status: number;
  readonly text: string;
}

export interface AccessTokenCacheConfig {
  /**
   * Prefix for every error, naming the exchange rather than the service — e.g.
   * `"Ramp token exchange"`, `"Superset login"`. It is what tells a caller that
   * the failure was authentication, not the request they actually made.
   */
  readonly label: string;
  /** Performs the exchange. Called at most once per process, lazily. */
  readonly exchange: () => Promise<AccessTokenResponse>;
  /**
   * Field holding the token in the parsed body. Defaults to `access_token`,
   * which is what all three of these APIs return.
   */
  readonly tokenField?: string;
  /** Body-snippet length in the thrown error. */
  readonly snippetMax?: number;
}

/** Body-snippet length in the thrown error. The value every connector used. */
export const DEFAULT_SNIPPET_MAX = 400;

/**
 * A `() => Promise<string>` that performs the exchange once and then returns
 * the cached token.
 *
 * Only a SUCCESSFUL exchange is cached. Caching a failure would make one
 * transient 503 at startup poison every later call for the life of the process,
 * which for a long-running stdio connector means until the client restarts it.
 *
 * Concurrent first calls share ONE exchange. An MCP client may have several
 * tool calls in flight at once, and each would otherwise find an empty cache
 * and start its own token request — n simultaneous OAuth exchanges for one
 * connector, which is both wasteful and a good way to meet a rate limit on the
 * auth endpoint. The in-flight promise is cleared whichever way it settles, so
 * a failed exchange stays retryable.
 */
export function createAccessTokenCache(config: AccessTokenCacheConfig): () => Promise<string> {
  const field = config.tokenField ?? "access_token";
  const snippetMax = config.snippetMax ?? DEFAULT_SNIPPET_MAX;
  let cached: string | null = null;
  let inFlight: Promise<string> | null = null;

  async function exchangeOnce(): Promise<string> {
    const res = await config.exchange();
    if (!res.ok) {
      throw new Error(`${config.label} ${String(res.status)}: ${res.text.slice(0, snippetMax)}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(res.text) as unknown;
    } catch {
      throw new Error(`${config.label}: invalid JSON response`);
    }
    const token = (parsed as Record<string, unknown> | null)?.[field];
    if (typeof token !== "string" || token === "") {
      throw new Error(`${config.label}: no ${field} in response`);
    }
    cached = token;
    return token;
  }

  return async (): Promise<string> => {
    if (cached !== null) {
      return cached;
    }
    inFlight ??= exchangeOnce();
    try {
      return await inFlight;
    } finally {
      // Cleared on BOTH paths. Keeping a rejected promise here would turn one
      // failed exchange into a permanently failing connector, which is the same
      // trap as caching the failure.
      inFlight = null;
    }
  };
}
