#!/usr/bin/env bun
import { relative, resolve } from "node:path";
/**
 * Run the per-connector sandbox contract suite.
 *
 * Every connector's `test/sandbox.test.ts` (see CONNECTOR_GLOB below) is gated on
 * `describe.skipIf(!process.env["NIMBUS_TEST_HARNESS"])`. Before this script that variable
 * was read in 79 places and set in none — no workflow, no script, no documented command —
 * so the suite had no invocation path at all and the exclusion notes that credited it were
 * describing something that never ran.
 *
 * It stays off by default for a real reason, not an oversight: `runSandboxContractTests`
 * forks a probe that opens a REAL connection to the connector's first declared network host
 * (`permissions.network[0]`) to prove the sandbox permits a listed host, and on non-Windows
 * a second probe that proves an unlisted host is refused. That is live outbound traffic to
 * ~79 vendor endpoints, so it belongs behind an explicit opt-in rather than in `bun test`.
 *
 * Consequences worth knowing before reading a red result:
 *   - A host that does not resolve from your network fails as `exit 6` / `exit 2`, which is
 *     an environment result, not a manifest defect. Check the host resolves before filing.
 *   - The unlisted-host probe is skipped on win32 by the SDK, so a Windows-only green run
 *     has proved the positive half of the contract only.
 *
 * Ported from the Nimbus monorepo, where it was retired when the connectors moved here. Its only
 * subject is these connectors' sandbox tests, so leaving it there would have left it scanning a
 * path that no longer exists — and deleting it without porting would have dropped the suite's only
 * invocation path a second time, which is the exact failure its own comment above describes.
 *
 * Env passthrough is explicit because `NIMBUS_TEST_HARNESS=1 bun test …` is a POSIX-shell
 * idiom that is a parse error in PowerShell (Non-Negotiable 5: platform equality).
 */
import { Glob } from "bun";

const REPO_ROOT = resolve(import.meta.dir, "..");
const CONNECTOR_GLOB = "connectors/*/test/sandbox.test.ts";

export async function findSandboxTests(root: string = REPO_ROOT): Promise<string[]> {
  const hits: string[] = [];
  for await (const file of new Glob(CONNECTOR_GLOB).scan({ cwd: root })) {
    hits.push(file.replaceAll("\\", "/"));
  }
  // localeCompare, matching the rest of this repo. A bare sort() orders by UTF-16 code unit,
  // which Sonar flags (typescript:S2871) as unreliable for alphabetical intent.
  return hits.sort((a, b) => a.localeCompare(b));
}

/**
 * The `bun test` argv for a set of discovered sandbox tests.
 *
 * Extra argv wins, so a single connector path can scope the run down. Split out of the
 * `import.meta.main` block so it can be tested — that guard is false under an import, which makes
 * anything inside it unreachable to every in-process test, and the alternative was excluding this
 * file from coverage entirely.
 */
export function targetsFor(files: readonly string[], extra: readonly string[]): string[] {
  if (extra.length > 0) return [...extra];
  return files.map((f) => relative(REPO_ROOT, resolve(REPO_ROOT, f)));
}

/** The banner shown before a run that makes real outbound requests. */
export function runBanner(count: number): string {
  return (
    `Running ${String(count)} sandbox contract tests. These make real outbound ` +
    `requests to each connector's declared host.`
  );
}

if (import.meta.main) {
  const files = await findSandboxTests();
  if (files.length === 0) {
    console.error(`No sandbox tests matched ${CONNECTOR_GLOB} under ${REPO_ROOT}.`);
    process.exit(1);
  }
  console.error(runBanner(files.length));
  const proc = Bun.spawn(["bun", "test", ...targetsFor(files, process.argv.slice(2))], {
    cwd: REPO_ROOT,
    stdout: "inherit",
    stderr: "inherit",
    env: { ...process.env, NIMBUS_TEST_HARNESS: "1" },
  });
  process.exit(await proc.exited);
}
