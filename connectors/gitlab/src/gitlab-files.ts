/**
 * gitlab-files: read files at a commit through the Repository Files API, for the batch read
 * (`gitlab_files_get`), the prepare tool (`gitlab_commit_prepare`) and the commit
 * (`gitlab_commit_create`), so what the owner was shown and what is committed come from one reader.
 *
 * Sources (https://docs.gitlab.com/api/{repository_files,branches,commits}/):
 * - `GET /projects/:id/repository/files/:file_path?ref=` returns `content` (base64), `blob_id`,
 *   `commit_id`, `last_commit_id`, `execute_filemode` and `size`; the file path is fully URL-encoded,
 *   slashes as `%2F` and, in the page's examples, dots as `%2E` (`lib%2Fclass%2Erb`).
 * - `GET /projects/:id/repository/branches/:branch` returns `commit.id`.
 * - `GET /projects/:id/repository/commits/:sha` accepts a hash, a branch or a tag name; `id` is the
 *   full hash.
 */

import { decodeBase64Text, notOverwritable } from "../../../shared/commit-files.ts";
import type { RestFetchResult } from "../../../shared/rest-tool-kit.ts";

/** A GET against the GitLab API: a path relative to the API base, already carrying the token. */
export type GitlabGet = (path: string) => Promise<RestFetchResult>;

const FULL_SHA = /^[0-9a-f]{40}$/i;

export type GitlabFileRead =
  | { readonly path: string; readonly exists: false }
  | {
      readonly path: string;
      readonly exists: true;
      readonly kind: "text";
      readonly lastCommitId: string;
      readonly executable: boolean;
      readonly size: number;
      readonly content: string;
    }
  | {
      readonly path: string;
      readonly exists: true;
      readonly kind: "binary" | "too-large" | "budget";
      readonly lastCommitId: string;
      readonly executable: boolean;
      readonly size: number;
    };

/** A file path as GitLab's API wants it: `encodeURIComponent`, plus every `.` as `%2E`. */
export function encodeFilePath(path: string): string {
  return encodeURIComponent(path).replaceAll(".", "%2E");
}

function fail(res: { status: number; text: string }): never {
  throw new Error(`GitLab ${String(res.status)}: ${res.text.slice(0, 300)}`);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** The commit a BRANCH points at now. */
export async function branchHead(get: GitlabGet, project: string, branch: string): Promise<string> {
  const res = await get(`/projects/${project}/repository/branches/${encodeURIComponent(branch)}`);
  if (res.status === 404) throw new Error(`GitLab 404: branch "${branch}" not found`);
  if (!res.ok) fail(res);
  const commit = isRecord(res.json) && isRecord(res.json["commit"]) ? res.json["commit"] : {};
  const id = commit["id"];
  if (typeof id !== "string" || !FULL_SHA.test(id))
    throw new Error("GitLab returned no branch head");
  return id.toLowerCase();
}

/** The commit a branch, tag or sha names. */
export async function refCommit(get: GitlabGet, project: string, ref: string): Promise<string> {
  const res = await get(`/projects/${project}/repository/commits/${encodeURIComponent(ref)}`);
  if (res.status === 404) throw new Error(`GitLab 404: ref "${ref}" not found`);
  if (!res.ok) fail(res);
  const id = isRecord(res.json) ? res.json["id"] : undefined;
  if (typeof id !== "string" || !FULL_SHA.test(id)) throw new Error("GitLab returned no commit id");
  return id.toLowerCase();
}

/** Entries per tree page (the API's own maximum is not stated on its page; 100 is what it is asked for). */
const TREE_PAGE = 100;
/** A directory of more than this many pages (5,000 entries) is refused rather than guessed about. */
const TREE_MAX_PAGES = 50;

type TreeEntry = { readonly path: string; readonly type: string; readonly mode: string };

/**
 * The entries of directory `dir` ("" for the root) at `sha`, paged until a short page.
 * `GET /projects/:id/repository/tree?path=&ref=&per_page=&page=`; each entry has `id, name, path, mode,
 * type` (https://docs.gitlab.com/api/repositories/). A 404 is a directory that does not exist.
 */
async function listTree(
  get: GitlabGet,
  project: string,
  sha: string,
  dir: string,
): Promise<TreeEntry[]> {
  const out: TreeEntry[] = [];
  for (let page = 1; page <= TREE_MAX_PAGES; page++) {
    const q = new URLSearchParams();
    if (dir !== "") q.set("path", dir);
    q.set("ref", sha);
    q.set("per_page", String(TREE_PAGE));
    q.set("page", String(page));
    const res = await get(`/projects/${project}/repository/tree?${q.toString()}`); // NOSONAR S9382: pages are read in order until a short one.
    if (res.status === 404) return out;
    if (!res.ok) fail(res);
    const entries = Array.isArray(res.json) ? res.json : [];
    for (const e of entries) {
      if (isRecord(e) && typeof e["path"] === "string" && typeof e["type"] === "string") {
        out.push({
          path: e["path"],
          type: e["type"],
          mode: typeof e["mode"] === "string" ? e["mode"] : "",
        });
      }
    }
    if (entries.length < TREE_PAGE) return out;
  }
  throw new Error(`GitLab directory "${dir}" has too many entries to check`);
}

/**
 * Refuse a target the commit tools must not write over. The Repository Files API reports no mode, so
 * a symlink reads as a text file holding its target; the tree listing does report one. For each
 * distinct parent directory (sorted, one listing per directory, paged) every target path must be
 * either absent or a plain `blob` whose mode is not 120000 (symlink) or 160000 (submodule); a
 * directory or a submodule where a file is expected is refused too, and so is an existing file the
 * listing does not show (it cannot be verified). Fail closed, before any write.
 */
export async function assertRegularTargets(
  get: GitlabGet,
  project: string,
  sha: string,
  files: readonly { readonly path: string; readonly exists: boolean }[],
): Promise<void> {
  const dirOf = (p: string): string => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");
  const dirs = [...new Set(files.map((f) => dirOf(f.path)))].sort((a, b) => a.localeCompare(b));
  const byPath = new Map<string, TreeEntry>();
  for (const dir of dirs) {
    for (const entry of await listTree(get, project, sha, dir)) byPath.set(entry.path, entry); // NOSONAR S9382
  }
  for (const f of files) {
    const entry = byPath.get(f.path);
    if (entry === undefined) {
      if (f.exists) throw notOverwritable(f.path);
      continue;
    }
    if (entry.type !== "blob" || entry.mode === "120000" || entry.mode === "160000") {
      throw notOverwritable(f.path);
    }
  }
}

/**
 * Read `paths` at the commit `sha`; a 404 for a path is `exists: false`. With `totalBudget`, the
 * content of all the files together is capped (the files API returns a file whole, so a withheld file
 * has still been transferred; only its content is dropped from the result).
 */
export async function readGitlabFilesAt(
  get: GitlabGet,
  project: string,
  sha: string,
  paths: readonly string[],
  maxReadBytes: number,
  totalBudget?: number,
): Promise<GitlabFileRead[]> {
  const out: GitlabFileRead[] = [];
  let used = 0;
  let exhausted = false;
  for (const path of paths) {
    const query = new URLSearchParams({ ref: sha }).toString();
    const res = await get(`/projects/${project}/repository/files/${encodeFilePath(path)}?${query}`); // NOSONAR S9382: sequential on purpose; paths are few and an error stops the read.
    if (res.status === 404) {
      out.push({ path, exists: false });
      continue;
    }
    if (!res.ok) fail(res);
    const f = isRecord(res.json) ? res.json : {};
    const lastCommitId = f["last_commit_id"];
    const content = f["content"];
    if (typeof lastCommitId !== "string" || typeof content !== "string") {
      throw new Error(`GitLab returned an unreadable file for ${path}`);
    }
    const size = typeof f["size"] === "number" ? f["size"] : 0;
    const executable = f["execute_filemode"] === true;
    if (size > maxReadBytes) {
      out.push({ path, exists: true, kind: "too-large", lastCommitId, executable, size });
      continue;
    }
    // The combined content of all the files is capped. The first file that does not fit, and every
    // one after it, is reported `budget` with its metadata and no content.
    if (totalBudget !== undefined && (exhausted || used + size > totalBudget)) {
      exhausted = true;
      out.push({ path, exists: true, kind: "budget", lastCommitId, executable, size });
      continue;
    }
    used += size;
    const decoded = decodeBase64Text(content);
    out.push(
      "binary" in decoded
        ? { path, exists: true, kind: "binary", lastCommitId, executable, size }
        : {
            path,
            exists: true,
            kind: "text",
            lastCommitId,
            executable,
            size,
            content: decoded.text,
          },
    );
  }
  return out;
}
