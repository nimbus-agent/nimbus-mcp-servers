/**
 * env-json-api — the read-only JSON GET client that 31 connectors had each
 * written out by hand.
 *
 * The shape below appeared, byte for byte, in every one of them:
 *
 * ```ts
 * function apiToken(): string {
 *   const t = process.env["X_TOKEN"]?.trim();
 *   if (t === undefined || t === "") throw new Error("X_TOKEN is not set");
 *   return t;
 * }
 * function authHeader(): Record<string, string> {
 *   return { Authorization: `Bearer ${apiToken()}`, Accept: "application/json" };
 * }
 * async function xGet(path: string): Promise<unknown> {
 *   const res = await fetch(`${BASE}${path}`, { headers: authHeader() });
 *   const text = await res.text();
 *   if (!res.ok) throw new Error(`X ${String(res.status)}: ${text.slice(0, 400)}`);
 *   return JSON.parse(text) as unknown;
 * }
 * ```
 *
 * Only four things ever varied: the base URL, the service label in the error,
 * the auth header, and (never, in practice) the 400-character snippet cap. So
 * those are the inputs and the rest is here once.
 *
 * This is deliberately NOT `rest-tool-kit`'s `makeRestFetcher`. That one returns
 * `{ ok, status, json, text }` for callers that branch on status; these 31
 * connectors all throw on a non-2xx and return parsed JSON, and rewriting their
 * tool bodies to the other contract would have been a behaviour change rather
 * than a deduplication. Both shapes are legitimate; this module owns the
 * throwing one.
 *
 * Environment is read at CALL time, not at module load. That is not incidental:
 * the connectors behaved that way (their `apiToken()` ran per request), tests
 * depend on being able to set the variable after import, and a connector must
 * fail with "X_TOKEN is not set" on the tool call rather than at startup.
 */

import { stripTrailingSlashes } from "./strip-trailing-slashes.ts";

/** Body-snippet length in the thrown error. The value every connector used. */
export const DEFAULT_SNIPPET_MAX = 400;

/**
 * `process.env[name]`, trimmed. Throws `"<name> is not set"` when the variable
 * is absent, empty, or whitespace only.
 *
 * Distinct from `requireProcessEnv` in `mcp-tool-kit`, which does not trim: a
 * variable set to a single space passes that check and then produces an
 * `Authorization: Bearer ` header and a puzzling 401. Every one of the 31
 * connectors trimmed, so trimming is the behaviour being preserved here.
 */
export function requiredEnv(name: string): string {
  const raw = process.env[name]?.trim();
  if (raw === undefined || raw === "") {
    throw new Error(`${name} is not set`);
  }
  return raw;
}

/** `process.env[name]`, trimmed, or `fallback` when absent or empty. */
export function optionalEnv(name: string, fallback: string): string {
  const raw = process.env[name]?.trim();
  return raw === undefined || raw === "" ? fallback : raw;
}

/**
 * A required base URL from the environment, with trailing slashes stripped so
 * `${base}${path}` cannot produce a double slash.
 */
export function requiredBaseUrl(name: string): string {
  return stripTrailingSlashes(requiredEnv(name));
}

/** An optional base URL from the environment, trailing slashes stripped. */
export function optionalBaseUrl(name: string, fallback: string): string {
  return stripTrailingSlashes(optionalEnv(name, fallback));
}

/** Builds the request headers. Called per request, so it reads env at call time. */
export type HeaderFactory = () => Record<string, string>;

/**
 * `{ [header]: "<scheme> <token>", Accept: "application/json", ...extra }` where
 * `token` is the trimmed value of `env`.
 *
 * `scheme` is the RFC 7235 auth scheme — `"Bearer"` for most, but the tree also
 * contains `"Token"` (Readwise, dbt, Flagsmith) and lowercase `"token"` (Snyk),
 * which are what those APIs actually accept and so are not normalised. Pass
 * `scheme: ""` for the APIs that want the bare credential with no scheme
 * (Bitrise, LaunchDarkly), and `header` for the ones that use their own header
 * instead of `Authorization` (Codemagic, Dependency-Track, Metabase, Zotero).
 */
export function envAuthHeaders(cfg: {
  readonly env: string;
  readonly scheme?: string;
  readonly header?: string;
  readonly extra?: Record<string, string>;
}): HeaderFactory {
  const header = cfg.header ?? "Authorization";
  const scheme = cfg.scheme ?? "Bearer";
  return (): Record<string, string> => {
    const token = requiredEnv(cfg.env);
    return {
      [header]: scheme === "" ? token : `${scheme} ${token}`,
      Accept: "application/json",
      ...cfg.extra,
    };
  };
}

export interface JsonApiConfig {
  /**
   * Base URL the path is appended to. A function when the base itself comes
   * from the environment, so it is resolved per request rather than at import.
   */
  readonly base: string | (() => string);
  /** Service name that prefixes a failure, e.g. `"Stripe 404: ..."`. */
  readonly label: string;
  readonly headers: HeaderFactory;
  /** Body-snippet length in the error. Defaults to {@link DEFAULT_SNIPPET_MAX}. */
  readonly snippetMax?: number;
}

/**
 * A `(path) => Promise<unknown>` GET client for `config`. Resolves to the parsed
 * JSON body, and throws `"<label> <status>: <body snippet>"` on any non-2xx.
 *
 * `path` is appended to the base as given — callers build it, and must
 * `encodeURIComponent` any user-supplied segment, exactly as before.
 */
export function createJsonGetter(config: JsonApiConfig): (path: string) => Promise<unknown> {
  const { base, label, headers } = config;
  const snippetMax = config.snippetMax ?? DEFAULT_SNIPPET_MAX;
  return async (path: string): Promise<unknown> => {
    const root = typeof base === "string" ? base : base();
    const res = await fetch(`${root}${path}`, { headers: headers() });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`${label} ${String(res.status)}: ${text.slice(0, snippetMax)}`);
    }
    return JSON.parse(text) as unknown;
  };
}
