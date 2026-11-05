/**
 * github-rest — the GitHub REST client the `github` and `github-actions`
 * connectors share.
 *
 * Both talk to the same API with the same token and had each written out its
 * base URL, its default headers, the fetch built from them and the
 * `/repos/<owner>/<repo>` path. The pinned `X-GitHub-Api-Version` lived in three
 * places, so a bump had to find all three.
 */

import { optionalBaseUrl } from "./env-json-api.ts";
import { makeRestFetcher, type RestFetchResult } from "./rest-tool-kit.ts";

export const GH_API = "https://api.github.com";

/**
 * The API base in force: `GITHUB_API_BASE_URL` (a GitHub Enterprise Server `https://host/api/v3`),
 * else {@link GH_API}. Read per call, so a test or an operator can change it without a restart.
 */
export function ghApiBase(): string {
  return optionalBaseUrl("GITHUB_API_BASE_URL", GH_API);
}

/** The media type GitHub documents for its REST API. */
export const GH_ACCEPT = "application/vnd.github+json";

/** The REST API version both connectors are written against. */
export const GH_API_VERSION = "2022-11-28";

/** Sent with every request, beside the Bearer token. */
export const GH_HEADERS: Record<string, string> = {
  Accept: GH_ACCEPT,
  "X-GitHub-Api-Version": GH_API_VERSION,
};

/** A Bearer-authenticated JSON request against {@link ghApiBase} (a relative path or a same-origin URL). */
export function ghFetch(token: string, path: string, init?: RequestInit): Promise<RestFetchResult> {
  return makeRestFetcher({ apiBase: ghApiBase(), token, defaultHeaders: GH_HEADERS })(path, init);
}

/** `/repos/<owner>/<repo>`, both segments URI-encoded. */
export function ghRepoPath(owner: string, repo: string): string {
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
}

/** The paging arguments every GitHub list tool accepts. */
export interface GhPaging {
  readonly perPage?: number | undefined;
  readonly page?: number | undefined;
}

/**
 * GitHub's paging parameters, in the order every list tool sends them: `per_page` (30 when not
 * given — GitHub's own default), then `page` only when one was given.
 */
export function setGhPaging(params: URLSearchParams, paging: GhPaging): void {
  params.set("per_page", String(paging.perPage ?? 30));
  if (paging.page !== undefined) {
    params.set("page", String(paging.page));
  }
}

/**
 * `path` plus the query string `setQuery` builds, as the relative path {@link ghFetch} takes. The
 * parameters keep the order `setQuery` sets them in.
 */
export function ghQueryPath(path: string, setQuery: (params: URLSearchParams) => void): string {
  // Parsed against the FIXED public origin, never the configured base: the result is relative to
  // the base ghFetch prepends, so a GHES `/api/v3` must not be in it.
  const u = new URL(`${GH_API}${path}`);
  setQuery(u.searchParams);
  return `${u.pathname}${u.search}`;
}
