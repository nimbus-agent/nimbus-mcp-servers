/**
 * private-kubeconfig — one kubeconfig file per tool call, never the owner's own.
 *
 * `kubectl` and `gcloud container clusters get-credentials` both read AND write a kubeconfig:
 * gcloud writes `$HOME/.kube/config` unless `KUBECONFIG` is set (first path if it is a list), and
 * kubectl takes the file `KUBECONFIG` names, or merges a list of them. Handed the owner's real
 * file, a tool call could change it, and two concurrent calls would share and race on it. So each
 * call works on a private copy in its own 0700 directory, removed afterwards, success or failure.
 *
 * Sources: https://kubernetes.io/docs/concepts/configuration/organize-cluster-access-kubeconfig/
 * (`--kubeconfig` set: only that file; else `KUBECONFIG` is a list, `:` on Linux and macOS, `;` on
 * Windows) and https://docs.cloud.google.com/sdk/gcloud/reference/container/clusters/get-credentials
 * (writes `HOME/.kube/config` unless `KUBECONFIG` is set).
 *
 * The copy is a plain file copy, not `kubectl config view --flatten`. One consequence is stated in
 * the connector READMEs: a kubeconfig whose certificate paths are RELATIVE resolves them against the
 * file's own directory, so a copy of such a file does not find them. Use absolute paths or
 * embedded certificate data.
 */

import { constants } from "node:fs";
import { lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";

/** Names the directory private kubeconfigs are made in; an absolute path, else `os.tmpdir()`. */
export const SCRATCH_DIR_ENV = "NIMBUS_CONNECTOR_SCRATCH_DIR";

/**
 * The one path `raw` (a `KUBECONFIG` value) names. A list of paths throws: a tool that cannot say
 * which file it works on cannot copy it. `separator` is the platform's `path.delimiter`, so a
 * Windows drive path (`C:\Users\me\config`, whose `:` is not a separator there) is one path, and
 * a `;` list is refused there; elsewhere a `:` list is.
 */
export function singleKubeconfigPath(
  raw: string | undefined,
  separator: string = delimiter,
): string {
  const p = raw?.trim();
  if (p === undefined || p === "") {
    throw new Error("KUBECONFIG env must be set to a kubeconfig file path");
  }
  if (p.split(separator).filter((piece) => piece.trim() !== "").length > 1) {
    throw new Error(
      `KUBECONFIG names more than one file (separator "${separator}"); set it to ONE kubeconfig path`,
    );
  }
  return p;
}

/** The base directory private kubeconfigs are made under. */
function scratchBase(): string {
  const configured = process.env[SCRATCH_DIR_ENV]?.trim();
  if (configured === undefined || configured === "") return tmpdir();
  if (!isAbsolute(configured)) {
    throw new Error(`${SCRATCH_DIR_ENV} must be an absolute path`);
  }
  return configured;
}

/** Refuse a source that is not a plain file: a symlink, a directory, a device. */
async function assertRegularFile(path: string): Promise<void> {
  const st = await lstat(path).catch(() => undefined);
  if (st === undefined) throw new Error("KUBECONFIG names a file that does not exist");
  if (st.isSymbolicLink() || !st.isFile()) {
    throw new Error("KUBECONFIG must name a regular file (not a symlink or a directory)");
  }
}

/**
 * Run `body` with a private kubeconfig.
 *
 * With `source` (a `KUBECONFIG` value, ONE path): the file is copied, mode 0600, and `body` gets
 * `{ KUBECONFIG: <copy> }`. Without it, the copy starts EMPTY, for `get-credentials` to fill.
 * The directory is removed when `body` settles.
 */
export async function withPrivateKubeconfig<T>(
  opts: { readonly source?: string | undefined },
  body: (env: { readonly KUBECONFIG: string }) => Promise<T>,
): Promise<T> {
  // Everything that can refuse does so BEFORE a directory exists.
  let content: Buffer | undefined;
  if (opts.source !== undefined) {
    const sourcePath = singleKubeconfigPath(opts.source);
    await assertRegularFile(sourcePath);
    content = await readFile(sourcePath);
  }
  const base = scratchBase();
  const dir = await mkdtemp(join(base, "nimbus-kubeconfig-"));
  try {
    const file = join(dir, "config");
    // `wx`: the file is new by construction, and an existing one is an error, not a reuse.
    await writeFile(file, content ?? "", {
      mode: 0o600,
      flag: constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
    });
    return await body({ KUBECONFIG: file });
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}
