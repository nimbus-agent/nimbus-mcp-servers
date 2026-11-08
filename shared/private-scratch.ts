/**
 * private-scratch — a private directory for one tool call's files, removed when the call settles.
 *
 * The CLI-backed write tools hand their CLI a file rather than an argument: a CloudFormation
 * template, a Kubernetes manifest. Each call gets its own 0700 directory under the configured
 * scratch base, so concurrent calls never share a file and nothing outlives the call.
 *
 * The base is `NIMBUS_CONNECTOR_SCRATCH_DIR` (absolute) when set. When it is not, `os.tmpdir()`,
 * with one exception: a Windows connector running under the gateway REFUSES. The gateway sandboxes
 * a Windows connector in an AppContainer and grants it a per-action directory through that env
 * var; the user temp directory is not that grant, so a file written there is either refused by
 * the sandbox or, worse, shared with every other process of the user. Failing closed names the
 * missing grant instead.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { getConnectorMode } from "./connector-mode.ts";

/** Names the directory scratch directories are made in; an absolute path. */
export const SCRATCH_DIR_ENV = "NIMBUS_CONNECTOR_SCRATCH_DIR";

/**
 * The configured scratch base, or `undefined` when none is configured. Throws on a relative
 * value: a relative base would resolve against whatever the connector's cwd happens to be.
 */
export function configuredScratchBase(): string | undefined {
  const configured = process.env[SCRATCH_DIR_ENV]?.trim();
  if (configured === undefined || configured === "") return undefined;
  if (!isAbsolute(configured)) {
    throw new Error(`${SCRATCH_DIR_ENV} must be an absolute path`);
  }
  return configured;
}

/**
 * The base a {@link withScratchDir} directory is made under (see the module comment for the
 * Windows-under-the-gateway refusal). `platform` is a parameter so both sides are testable.
 */
export function scratchDirBase(platform: NodeJS.Platform = process.platform): string {
  const configured = configuredScratchBase();
  if (configured !== undefined) return configured;
  if (platform === "win32" && getConnectorMode() === "gateway") {
    throw new Error(
      `${SCRATCH_DIR_ENV} is not set: on Windows the gateway must grant this connector a scratch ` +
        "directory, and the user temp directory is not one",
    );
  }
  return tmpdir();
}

/**
 * Run `body` with a fresh 0700 directory of its own, removed when `body` settles, success or
 * failure. `prefix` names the directory (`nimbus-cfn-`, `nimbus-k8s-`).
 */
export async function withScratchDir<T>(
  prefix: string,
  body: (dir: string) => Promise<T>,
): Promise<T> {
  const base = scratchDirBase();
  const dir = await mkdtemp(join(base, prefix));
  try {
    return await body(dir);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}
