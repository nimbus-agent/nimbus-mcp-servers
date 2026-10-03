/**
 * github-rest — the GitHub REST client the `github` and `github-actions`
 * connectors share.
 *
 * Both talk to the same API with the same token and had each written out its
 * base URL, its default headers, the fetch built from them and the
 * `/repos/<owner>/<repo>` path. The pinned `X-GitHub-Api-Version` lived in three
 * places, so a bump had to find all three.
 */

import { makeRestFetcher, type RestFetchResult } from "./rest-tool-kit.ts";

export const GH_API = "https://api.github.com";

/** The media type GitHub documents for its REST API. */
export const GH_ACCEPT = "application/vnd.github+json";

/** The REST API version both connectors are written against. */
export const GH_API_VERSION = "2022-11-28";

/** Sent with every request, beside the Bearer token. */
export const GH_HEADERS: Record<string, string> = {
  Accept: GH_ACCEPT,
  "X-GitHub-Api-Version": GH_API_VERSION,
};

/** A Bearer-authenticated JSON request against {@link GH_API} (a relative path or a same-origin URL). */
export function ghFetch(token: string, path: string, init?: RequestInit): Promise<RestFetchResult> {
  return makeRestFetcher({ apiBase: GH_API, token, defaultHeaders: GH_HEADERS })(path, init);
}

/** `/repos/<owner>/<repo>`, both segments URI-encoded. */
export function ghRepoPath(owner: string, repo: string): string {
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
}
