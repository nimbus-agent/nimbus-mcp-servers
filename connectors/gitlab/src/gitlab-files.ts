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

import { decodeBase64Text } from "../../../shared/commit-files.ts";
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
      readonly kind: "binary" | "too-large";
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

/** Read `paths` at the commit `sha`; a 404 for a path is `exists: false`. */
export async function readGitlabFilesAt(
  get: GitlabGet,
  project: string,
  sha: string,
  paths: readonly string[],
  maxReadBytes: number,
): Promise<GitlabFileRead[]> {
  const out: GitlabFileRead[] = [];
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
