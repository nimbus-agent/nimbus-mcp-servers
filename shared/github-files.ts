/**
 * github-files: read files at a commit through the Git Data API, for the batch read
 * (`github_files_get`), the prepare tool (`github_commit_prepare`) and the commit
 * (`github_file_commit`), so what the owner was shown and what is committed come from one reader.
 *
 * Sources (https://docs.github.com/en/rest/git/{commits,trees,blobs,refs}):
 * - `GET /git/commits/{sha}` returns `tree.sha`.
 * - `GET /git/trees/{sha}` (non-recursive) lists `path, mode, type, sha, size`, with a top-level
 *   `truncated` and the advice to "fetch subtrees one at a time": a path is walked one level at a
 *   time, and a truncated level is an error, never a guess that the file is absent.
 * - `GET /git/blobs/{sha}` returns base64 `content`.
 * - `PATCH /git/refs/heads/{branch}` with `force` false must be a fast-forward; the documented
 *   statuses are 200, 409 and 422.
 */

import { decodeBase64Text } from "./commit-files.ts";
import { ghFetch, ghRepoPath } from "./github-rest.ts";

type TreeEntry = { path: string; mode: string; type: string; sha: string; size?: number };

export type GithubFileRead =
  | { readonly path: string; readonly exists: false }
  | {
      readonly path: string;
      readonly exists: true;
      readonly kind: "text";
      readonly mode: string;
      readonly sha: string;
      readonly size: number;
      /** Present only when content was asked for. */
      readonly content?: string;
    }
  | {
      readonly path: string;
      readonly exists: true;
      readonly kind: "binary" | "not-regular" | "too-large";
      readonly mode: string;
      readonly sha: string;
      readonly size?: number;
    };

function fail(res: { status: number; text: string }): never {
  throw new Error(`GitHub ${String(res.status)}: ${res.text.slice(0, 300)}`);
}

async function getJson(token: string, path: string): Promise<unknown> {
  const res = await ghFetch(token, path);
  if (!res.ok) fail(res);
  return res.json;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** `tree.sha` of a commit. */
export async function commitTreeSha(
  token: string,
  owner: string,
  repo: string,
  commitSha: string,
): Promise<string> {
  const json = await getJson(token, `${ghRepoPath(owner, repo)}/git/commits/${commitSha}`);
  const tree = isRecord(json) && isRecord(json["tree"]) ? json["tree"]["sha"] : undefined;
  if (typeof tree !== "string") throw new Error("GitHub returned no tree for the commit");
  return tree;
}

function parseTree(json: unknown): TreeEntry[] {
  if (!isRecord(json)) throw new Error("GitHub returned no tree");
  if (json["truncated"] === true) {
    throw new Error("GitHub truncated a directory listing; refusing to guess a file is absent");
  }
  const entries = Array.isArray(json["tree"]) ? json["tree"] : [];
  const out: TreeEntry[] = [];
  for (const e of entries) {
    if (
      isRecord(e) &&
      typeof e["path"] === "string" &&
      typeof e["mode"] === "string" &&
      typeof e["type"] === "string" &&
      typeof e["sha"] === "string"
    ) {
      out.push({
        path: e["path"],
        mode: e["mode"],
        type: e["type"],
        sha: e["sha"],
        ...(typeof e["size"] === "number" ? { size: e["size"] } : {}),
      });
    }
  }
  return out;
}

/** The tree entry for `path` under `rootTreeSha`, one directory level at a time; undefined if absent. */
async function findEntry(
  token: string,
  owner: string,
  repo: string,
  rootTreeSha: string,
  path: string,
  cache: Map<string, TreeEntry[]>,
): Promise<TreeEntry | undefined> {
  const segments = path.split("/");
  let treeSha = rootTreeSha;
  for (const [i, segment] of segments.entries()) {
    let entries = cache.get(treeSha);
    if (entries === undefined) {
      entries = parseTree(await getJson(token, `${ghRepoPath(owner, repo)}/git/trees/${treeSha}`));
      cache.set(treeSha, entries);
    }
    const entry = entries.find((e) => e.path === segment);
    if (entry === undefined) return undefined;
    if (i === segments.length - 1) return entry;
    if (entry.type !== "tree") {
      // A file sits where a directory is needed: the path cannot exist, and a commit cannot create it.
      throw new Error(`${path}: ${segments.slice(0, i + 1).join("/")} is a file, not a directory`);
    }
    treeSha = entry.sha;
  }
  return undefined;
}

/**
 * Read `paths` at `commitSha`, returning the commit's root tree sha beside the files. With `withContent`, each text file's content is fetched (a file over
 * `maxReadBytes` is reported `too-large` without fetching it); without, only the tree entry is read,
 * which is enough for a mode, a blob sha and a size.
 */
export async function readGithubFilesAt(
  token: string,
  owner: string,
  repo: string,
  commitSha: string,
  paths: readonly string[],
  opts: { readonly withContent: boolean; readonly maxReadBytes: number },
): Promise<{ readonly treeSha: string; readonly files: GithubFileRead[] }> {
  const rootTree = await commitTreeSha(token, owner, repo, commitSha);
  const cache = new Map<string, TreeEntry[]>();
  const out: GithubFileRead[] = [];
  for (const path of paths) {
    const entry = await findEntry(token, owner, repo, rootTree, path, cache); // NOSONAR S9382: sequential on purpose; the tree cache makes later paths cheap.
    if (entry === undefined) {
      out.push({ path, exists: false });
      continue;
    }
    if (entry.type !== "blob" || entry.mode === "120000") {
      out.push({ path, exists: true, kind: "not-regular", mode: entry.mode, sha: entry.sha });
      continue;
    }
    const size = entry.size ?? 0;
    if (size > opts.maxReadBytes) {
      out.push({ path, exists: true, kind: "too-large", mode: entry.mode, sha: entry.sha, size });
      continue;
    }
    if (!opts.withContent) {
      out.push({ path, exists: true, kind: "text", mode: entry.mode, sha: entry.sha, size });
      continue;
    }
    const blob = await getJson(token, `${ghRepoPath(owner, repo)}/git/blobs/${entry.sha}`); // NOSONAR S9382
    const b64 = isRecord(blob) && blob["encoding"] === "base64" ? blob["content"] : undefined;
    if (typeof b64 !== "string") throw new Error(`GitHub returned no base64 content for ${path}`);
    const decoded = decodeBase64Text(b64);
    out.push(
      "binary" in decoded
        ? { path, exists: true, kind: "binary", mode: entry.mode, sha: entry.sha, size }
        : {
            path,
            exists: true,
            kind: "text",
            mode: entry.mode,
            sha: entry.sha,
            size,
            content: decoded.text,
          },
    );
  }
  return { treeSha: rootTree, files: out };
}
