/**
 * walk-files — the bounded recursive directory walk the local-filesystem
 * connectors share, and the path-traversal guard that goes with it.
 *
 * `great-expectations`, `localdb` and `dataprofile` each scan a configured
 * directory tree for the files they care about (`*.json`, `*.sql`, and a set of
 * tabular extensions), and each had written out the same walk: recurse, stop at
 * a depth limit, stop at a file-count limit, swallow an unreadable directory
 * rather than aborting the scan.
 *
 * Those two limits are why this is worth sharing rather than tolerating. They
 * are the guard against a connector being pointed — by configuration or by a
 * symlink — at a tree deep or wide enough to exhaust the process, and a guard
 * maintained in three places is a guard that can be tightened in one and left
 * alone in the other two. They were already inconsistent: 1000 files for
 * great-expectations against 2000 for the others. That difference is real (a
 * GX run directory is small) so it stays a per-caller argument rather than
 * being averaged away — but it is now visibly an argument rather than three
 * independent constants that happen to differ.
 *
 * The same three connectors each carried a copy of {@link assertWithinDir} too,
 * identical but for the directory named in the error — a second security
 * control in three hand-written copies, shared for the same reason.
 */

import type { Dirent } from "node:fs";
import { readdir } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";

export interface WalkFilesOptions<T> {
  /** Hard cap on results. The walk stops as soon as it is reached. */
  readonly maxFiles: number;
  /** Hard cap on recursion depth, counted from `root` at 0. */
  readonly maxDepth: number;
  /**
   * What to keep for one file entry, or `undefined` to skip it. Receives the
   * directory entry and its full path, so a caller can select on the name, the
   * extension, or anything else it can decide without reading the file.
   */
  readonly select: (entry: Dirent, fullPath: string) => T | undefined;
}

/**
 * Collect what `select` keeps, walking `root` depth-first within the limits.
 *
 * An unreadable directory is SKIPPED rather than fatal: a scan of a
 * user-configured tree meets permission-denied subdirectories routinely, and
 * failing the whole tool call for one of them would make the connector useless
 * on a real machine. A caller that needs to know a directory was unreadable
 * should stat it itself.
 *
 * Symlinks are not followed — `readdir` reports a link as neither a file nor a
 * directory here, so a cycle cannot make the walk diverge.
 */
export async function walkFiles<T>(root: string, options: WalkFilesOptions<T>): Promise<T[]> {
  const found: T[] = [];

  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > options.maxDepth || found.length >= options.maxFiles) {
      return;
    }
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (found.length >= options.maxFiles) {
        return;
      }
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full, depth + 1); // NOSONAR S9382: depth-first under one shared maxFiles cap — a subtree must finish before the next starts or the cap stops at a nondeterministic point, and concurrent readdirs over a wide tree are the exhaustion this walk exists to bound.
      } else if (entry.isFile()) {
        const kept = options.select(entry, full);
        if (kept !== undefined) {
          found.push(kept);
        }
      }
    }
  }

  await walk(root, 0);
  return found;
}

/**
 * A {@link WalkFilesOptions.select} that keeps the full path of every file with
 * one of `extensions`, compared case-insensitively.
 */
export function byExtension(
  ...extensions: readonly string[]
): (e: Dirent, full: string) => string | undefined {
  const wanted = extensions.map((x) => x.toLowerCase());
  return (entry: Dirent, full: string): string | undefined =>
    wanted.some((x) => entry.name.toLowerCase().endsWith(x)) ? full : undefined;
}

/**
 * The path-traversal guard: throws `"path escapes <what>"` unless `candidate` (an
 * absolute, resolved path) is `root` itself or a descendant of it. `what` names the
 * directory for the message, e.g. `"the configured local DB scripts dir"`.
 *
 * A `relative()` that starts with `..` climbed out of `root` (this also covers
 * `..<sep>`); one that is absolute could not be expressed relative to it at all — a
 * different drive on Windows. It fails closed: a child whose own name begins with
 * `..` (such as `..cache`) is refused too.
 */
export function assertWithinDir(candidate: string, root: string, what: string): void {
  const rel = relative(root, candidate);
  if (rel === "") {
    return;
  }
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`path escapes ${what}`);
  }
}
