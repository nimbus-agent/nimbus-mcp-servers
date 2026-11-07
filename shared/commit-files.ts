/**
 * commit-files: what the multi-file commit tools (`github_file_commit`, `gitlab_commit_create`) and
 * their prepare tools (`github_commit_prepare`, `gitlab_commit_prepare`) agree on, so the preview the
 * owner approves and the commit that runs are bounded by the same rules.
 *
 * - Text files only, written whole: no deletes, no mode changes, no symlinks, no submodules.
 * - At most {@link COMMIT_MAX_FILES} files, and the combined size of the old content that is shown and
 *   the new content that is sent at most {@link COMMIT_MAX_COMBINED_BYTES}. The prepare tool REFUSES a
 *   bigger commit rather than truncating: the preview never shows less than is sent, and its reply
 *   stays under the gateway's 256 KiB cap.
 */

import { z } from "zod";

export const COMMIT_MAX_FILES = 20;
export const COMMIT_MAX_COMBINED_BYTES = 192 * 1024;

const FULL_SHA = /^[0-9a-f]{40}$/i;

/** A full 40-hex commit sha, any case. */
export const fullShaSchema = z.string().regex(FULL_SHA, "a full 40-hex commit sha");

/**
 * A character the approval preview cannot be trusted to show as it is: any Unicode control (Cc, which
 * includes DEL and the C1 range U+0080..U+009F), format character (Cf: bidi overrides, zero-width
 * spaces, the byte-order mark), line or paragraph separator (Zl, Zp), or lone surrogate (Cs).
 */
const UNSHOWABLE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Cs}]/u;

/**
 * Whether a path segment spells `.git` on a filesystem that folds it: NTFS and HFS+ ignore trailing
 * dots and spaces and compare case-insensitively, and NTFS also knows the short name `GIT~1`. A
 * segment that is nothing but dots and spaces is refused too, since it folds to the empty name.
 */
function isGitSpelling(segment: string): boolean {
  const folded = segment.replace(/[. ]+$/u, "").toLowerCase();
  return folded === "" || folded === ".git" || folded === "git~1";
}

/**
 * Whether `path` is a repository-relative file path the commit tools accept: 1..1024 characters, no
 * leading or trailing `/`, no `//`, no backslash, no unshowable character (see {@link UNSHOWABLE}),
 * and no `.` or `..` segment or spelling of `.git` (see {@link isGitSpelling}). The path reaches a
 * URL path or a JSON body, never a shell.
 */
export function isSafeCommitPath(path: string): boolean {
  if (path.length < 1 || path.length > 1024) return false;
  if (path.startsWith("/") || path.endsWith("/") || path.includes("//") || path.includes("\\")) {
    return false;
  }
  if (UNSHOWABLE.test(path)) return false;
  return path.split("/").every((seg) => seg !== "." && seg !== ".." && !isGitSpelling(seg));
}

export const commitFilePathSchema = z
  .string()
  .refine(isSafeCommitPath, "not a safe repository file path");

/** One file of a commit: its path and its whole new text. */
export const commitFileSchema = z.object({
  path: commitFilePathSchema,
  content: z.string(),
});

export type CommitFile = z.infer<typeof commitFileSchema>;

/** The `files` field: 1..{@link COMMIT_MAX_FILES} entries. Uniqueness is checked by {@link assertCommitFiles}. */
export const commitFilesSchema = z.array(commitFileSchema).min(1).max(COMMIT_MAX_FILES);

/** UTF-8 byte length of `text`. */
export function utf8Length(text: string): number {
  return new TextEncoder().encode(text).length;
}

/**
 * The checks a schema cannot make (a schema holding them would have to be `.refine()`d, which loses
 * `.shape`): paths unique, and the NEW content alone within the combined cap. Throws a fixed message.
 */
export function assertCommitFiles(files: readonly CommitFile[]): void {
  if (files.length > COMMIT_MAX_FILES) {
    throw new Error(`a commit may touch at most ${String(COMMIT_MAX_FILES)} files`);
  }
  const seen = new Set<string>();
  for (const f of files) {
    if (seen.has(f.path)) throw new Error(`duplicate file path in commit: ${f.path}`);
    seen.add(f.path);
  }
  // A path and one beneath it (`a` and `a/b`) cannot both be files of one tree.
  for (const path of seen) {
    const segments = path.split("/");
    for (let i = 1; i < segments.length; i++) {
      const parent = segments.slice(0, i).join("/");
      if (seen.has(parent)) {
        throw new Error(
          `path collision in commit: ${parent} is a file and also a directory of ${path}`,
        );
      }
    }
  }
  const bytes = files.reduce((n, f) => n + utf8Length(f.content), 0);
  if (bytes > COMMIT_MAX_COMBINED_BYTES) {
    throw new Error(commitTooLarge());
  }
}

/** The one refusal for a commit over the combined cap. */
export function commitTooLarge(): string {
  return `commit too large: the old and new content together exceed ${String(COMMIT_MAX_COMBINED_BYTES / 1024)} KiB`;
}

/** Throws when `oldBytes + newBytes` is over the combined cap. */
export function assertCombinedSize(oldBytes: number, files: readonly CommitFile[]): void {
  const newBytes = files.reduce((n, f) => n + utf8Length(f.content), 0);
  if (oldBytes + newBytes > COMMIT_MAX_COMBINED_BYTES) throw new Error(commitTooLarge());
}

export type DecodedText = { readonly text: string } | { readonly binary: true };

/**
 * Decode base64 file bytes as UTF-8. Bytes that are not valid UTF-8, or that hold a NUL, are
 * `binary`: their content is withheld and the commit tools refuse to overwrite them.
 */
export function decodeBase64Text(base64: string): DecodedText {
  const bytes = Buffer.from(base64.replaceAll(/\s/g, ""), "base64");
  if (bytes.includes(0)) return { binary: true };
  try {
    return { text: new TextDecoder("utf-8", { fatal: true }).decode(bytes) };
  } catch {
    return { binary: true };
  }
}

/** The error a commit tool throws for an existing file it will not overwrite. */
export function notOverwritable(path: string): Error {
  return new Error(
    `${path} is not a text file the commit tools can overwrite (binary, symlink, submodule, a directory in the way, or too large)`,
  );
}
