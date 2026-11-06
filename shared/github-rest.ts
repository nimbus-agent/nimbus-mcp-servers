/**
 * github-rest — the GitHub REST client the `github` and `github-actions`
 * connectors share.
 *
 * Both talk to the same API with the same token and had each written out its
 * base URL, its default headers, the fetch built from them and the
 * `/repos/<owner>/<repo>` path. The pinned `X-GitHub-Api-Version` lived in three
 * places, so a bump had to find all three.
 */

import { resolveUrlWithBase } from "@nimbus-dev/sdk/connector-kit";
import { optionalBaseUrl } from "./env-json-api.ts";
import { guardedFetch } from "./guarded-fetch.ts";
import { type RestFetchResult, toRestFetchResult } from "./rest-tool-kit.ts";

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

/**
 * A Bearer-authenticated JSON request against {@link ghApiBase} (a relative path or a same-origin
 * URL). It goes through {@link guardedFetch}: a write that GitHub answers with a redirect (a renamed
 * or transferred repository) is refused, not replayed as a GET that would report a false success,
 * and a GET follows only a same-origin https redirect, at most 3 hops.
 */
export async function ghFetch(
  token: string,
  path: string,
  init?: RequestInit,
): Promise<RestFetchResult> {
  const url = resolveUrlWithBase(ghApiBase(), path);
  const headers = new Headers({ Authorization: `Bearer ${token}`, ...GH_HEADERS });
  if (init?.headers !== undefined) {
    for (const [k, v] of new Headers(init.headers)) headers.set(k, v);
  }
  const res = await guardedFetch("GitHub", url, { ...init, headers }, { requireSecureBase: false });
  return toRestFetchResult(res);
}

/**
 * Whether `seg` is a safe GitHub `owner` or `repo`: 1..100 of `[A-Za-z0-9._-]`, and not `.` or `..`
 * (a URL parser collapses those out of the path, turning `/repos/../../pulls/9` into another endpoint).
 */
export function isSafeGhSlug(seg: string): boolean {
  return /^[A-Za-z0-9._-]{1,100}$/.test(seg) && seg !== "." && seg !== "..";
}

/**
 * `/repos/<owner>/<repo>`, both segments URI-encoded. `.` and `..` are refused: `encodeURIComponent`
 * leaves them alone and a URL parser collapses them (`/repos/../../pulls/9`).
 */
export function ghRepoPath(owner: string, repo: string): string {
  for (const seg of [owner, repo]) {
    if (seg === "." || seg === "..") throw new Error("owner and repo cannot be a dot segment");
  }
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

/**
 * Whether `ref` is safe to place in a GitHub API path and to hand to GitHub as a ref name.
 *
 * A ref reaches a URL path, so a hostile one is a path-traversal vector (`../x` would climb out of
 * `/commits/`). One rule for every ref the model supplies: 1..255 characters of
 * `[A-Za-z0-9._/-]`, no `..`, no leading or trailing `/`, no `//`, no leading `-`, no segment that
 * starts with `.` or ends with `.lock`, and no trailing `.`.
 */
export function isSafeGitRef(ref: string): boolean {
  if (ref.length < 1 || ref.length > 255) return false;
  if (!/^[A-Za-z0-9._/-]+$/.test(ref)) return false;
  if (ref.startsWith("/") || ref.endsWith("/") || ref.startsWith("-") || ref.endsWith(".")) {
    return false;
  }
  if (ref.includes("//") || ref.includes("..")) return false;
  return ref.split("/").every((seg) => !seg.startsWith(".") && !seg.endsWith(".lock"));
}

/** What a ref resolved to: the commit SHA, and whether the name was a branch, a tag or a SHA. */
export interface ResolvedCommit {
  readonly sha: string;
  readonly kind: "branch" | "tag" | "sha";
}

const FULL_SHA = /^[0-9a-f]{40}$/i;

/** One `GET /commits/<ref>` with the SHA media type; `undefined` on a 404, a throw on anything else. */
async function commitShaFor(
  token: string,
  owner: string,
  repo: string,
  ref: string,
): Promise<string | undefined> {
  const segments = ref.split("/").map(encodeURIComponent).join("/");
  const res = await ghFetch(token, `${ghRepoPath(owner, repo)}/commits/${segments}`, {
    headers: { Accept: "application/vnd.github.sha" },
  });
  if (res.status === 404) return undefined;
  if (!res.ok) {
    throw new Error(`GitHub ${String(res.status)}: ${res.text.slice(0, 300)}`);
  }
  const sha = res.text.trim();
  if (!FULL_SHA.test(sha)) {
    throw new Error(`GitHub returned no commit sha for ref "${ref}"`);
  }
  return sha.toLowerCase();
}

/** The names to try for `ref`, in order: a `heads/` or `tags/` prefix is one, a bare name is both. */
function refCandidates(ref: string): { readonly name: string; readonly kind: "branch" | "tag" }[] {
  if (ref.startsWith("heads/")) return [{ name: ref, kind: "branch" }];
  if (ref.startsWith("tags/")) return [{ name: ref, kind: "tag" }];
  return [
    { name: `heads/${ref}`, kind: "branch" },
    { name: `tags/${ref}`, kind: "tag" },
  ];
}

/**
 * Resolve a branch, tag or commit to a COMMIT sha. `ref` must already satisfy {@link isSafeGitRef}.
 *
 * A 40-hex string is returned as is. `heads/*` or `tags/*` is one GET. A bare name tries
 * `heads/<ref>` then `tags/<ref>`, falling through only on a 404. It reads `/commits/<ref>` and not
 * `/git/ref/<ref>` so an annotated tag is peeled to a commit (a branch cannot point at a tag object).
 * The read tool and the write tool share this, so what a name means cannot differ between the
 * before-state the owner saw and the write that runs.
 */
export async function resolveCommitSha(
  token: string,
  owner: string,
  repo: string,
  ref: string,
): Promise<ResolvedCommit> {
  if (FULL_SHA.test(ref)) return { sha: ref.toLowerCase(), kind: "sha" };
  for (const c of refCandidates(ref)) {
    const sha = await commitShaFor(token, owner, repo, c.name);
    if (sha !== undefined) return { sha, kind: c.kind };
  }
  throw new Error(`GitHub 404: ref "${ref}" not found`);
}
