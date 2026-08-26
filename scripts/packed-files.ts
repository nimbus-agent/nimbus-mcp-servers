import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(import.meta.url), "..", "..");

let cached: string[] | undefined;

/**
 * The files `npm publish` would ship, as npm itself reports them.
 *
 * Asked of npm rather than reimplemented: `npm pack --dry-run` applies the real `files` semantics —
 * negations, directory recursion, the always-included set — which a hand-rolled glob walk would
 * only approximate, and an approximation that disagrees with the packer certifies the wrong tree.
 *
 * Memoised because spawning npm is the expensive part and more than one test needs this list.
 * `bun test` runs the suite in one process, so the cache is shared across files. That is not a
 * micro-optimisation: two unmemoised spawns took 5005 ms against a 5000 ms default timeout on the
 * Windows CI runner and failed the leg, while the same test pair ran in ~2.2 s locally.
 */
export function packedFiles(): string[] {
  if (cached !== undefined) return cached;
  const out = Bun.spawnSync(["npm", "pack", "--dry-run"], { cwd: ROOT, stderr: "pipe" });
  const text = new TextDecoder().decode(out.stderr) + new TextDecoder().decode(out.stdout);
  cached = text
    .split("\n")
    .map((l) => l.replace(/^npm notice /, "").trim())
    .filter((l) => /^[\d.]+\s*[kMG]?B\s+\S/.test(l))
    .map((l) => l.split(/\s+/).slice(1).join(" "))
    .filter((l) => l.length > 0);
  return cached;
}

/**
 * Budget for a test that calls `packedFiles()`.
 *
 * The Windows runner is many times slower than a dev machine at spawning npm, so the default 5 s is
 * not a safe bound for work that is genuinely fast — it bounds a hang, not the run.
 */
export const PACK_TIMEOUT_MS = 120_000;
