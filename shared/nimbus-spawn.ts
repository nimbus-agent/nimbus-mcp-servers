/**
 * nimbus-spawn — the one place this package starts a process.
 *
 * Every connector that reaches its service through a CLI spawns it through {@link nimbusSpawn},
 * directly or by way of `run-cli-json.ts` and `cli-json-kit.ts`, and `scripts/spawn-chokepoint.test.ts`
 * fails any other shipped file that imports a module able to start a process, in any import form,
 * or refers to the `Bun` global at all. That is what makes a rule
 * enforced here hold for every connector: today, `windows-batch-args.ts`'s refusal of an argument
 * cmd.exe would act on, when the program may start a Windows batch file. Both implementations
 * build the child's environment once and hand the SAME object to that check and to the spawn, so
 * the environment that was checked is the one the child gets.
 */

import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { batchArgumentRefusal } from "./windows-batch-args.ts";

export type SpawnResult = { code: number; stdout: string; stderr: string };

/**
 * The child's environment for `env`, and why `command` must not be spawned with it, if it must
 * not. Nothing is spawned for a refused command: it resolves as a failure whose stderr says so.
 */
function prepareSpawn(
  command: readonly string[],
  env: Record<string, string | undefined>,
): { childEnv: Record<string, string | undefined>; refusal: SpawnResult | undefined } {
  const childEnv = { ...process.env, ...env };
  const refusal = batchArgumentRefusal(command, childEnv);
  return {
    childEnv,
    refusal: refusal === undefined ? undefined : { code: 1, stdout: "", stderr: refusal },
  };
}

/**
 * Collect a child's output and resolve with it once the child closes or fails to start.
 *
 * Output is accumulated as raw `Buffer`s and decoded ONCE at the end. Decoding each chunk with
 * `chunk.toString("utf8")` corrupts any multi-byte character that straddles a chunk boundary, and
 * chunk boundaries are a function of pipe timing — so it fails intermittently, on non-ASCII data,
 * in production.
 */
function collectOutput(
  child: ChildProcessWithoutNullStreams,
  resolveP: (result: SpawnResult) => void,
): void {
  const outChunks: Buffer[] = [];
  const errChunks: Buffer[] = [];
  child.stdout.on("data", (c: Buffer) => {
    outChunks.push(c);
  });
  child.stderr.on("data", (c: Buffer) => {
    errChunks.push(c);
  });
  const decode = (): { stdout: string; stderr: string } => ({
    stdout: Buffer.concat(outChunks).toString("utf8"),
    stderr: Buffer.concat(errChunks).toString("utf8"),
  });
  child.on("error", (e: Error) => {
    const d = decode();
    resolveP({ code: 1, stdout: d.stdout, stderr: `${d.stderr}${e.message}` });
  });
  child.on("close", (code: number | null) => {
    resolveP({ code: code ?? 1, ...decode() });
  });
}

/**
 * Node implementation. Exported so it can be tested directly: the suite runs under Bun, so
 * `nimbusSpawn` would otherwise never exercise this branch and it would ship unverified.
 *
 * Two Node APIs are deliberately NOT used, and the reasons are not obvious:
 *
 *  - `spawnSync` blocks the event loop. In a stdio MCP server that must keep answering JSON-RPC —
 *    including an in-flight `elicitation/create` round-trip — a synchronous spawn deadlocks the
 *    consent gate against itself.
 *  - `execFile` caps captured output at a 1 MB `maxBuffer` by default and errors past it. The
 *    `Bun.spawn` path reads stdout uncapped, and `aws logs` / `gcloud logging` JSON routinely
 *    exceeds 1 MB, so `execFile` would be a silent-truncation regression dressed up as a
 *    portability fix.
 */
export function spawnViaNode(
  command: readonly string[],
  env: Record<string, string | undefined>,
): Promise<SpawnResult> {
  const [bin, ...args] = command;
  if (bin === undefined) {
    return Promise.resolve({ code: 1, stdout: "", stderr: "empty command" });
  }
  const { childEnv, refusal } = prepareSpawn(command, env);
  if (refusal !== undefined) {
    return Promise.resolve(refusal);
  }
  return new Promise((resolveP) => {
    // `spawn` THROWS, rather than emitting "error", for a command it cannot start at all: an
    // argument holding a NUL byte, or — on Node, though not in Bun's `node:child_process` — a
    // `.cmd` or `.bat` without a shell, which Node refuses with EINVAL. Uncaught, the throw would
    // REJECT this promise, against the contract both implementations keep.
    try {
      collectOutput(spawn(bin, args, { env: childEnv }), resolveP);
    } catch (e) {
      resolveP({ code: 1, stdout: "", stderr: e instanceof Error ? e.message : String(e) });
    }
  });
}

/** Bun implementation. Draining the whole stream decodes multi-byte characters correctly. */
export async function spawnViaBun(
  command: readonly string[],
  env: Record<string, string | undefined>,
): Promise<SpawnResult> {
  if (command.length === 0) {
    return { code: 1, stdout: "", stderr: "empty command" };
  }
  const { childEnv, refusal } = prepareSpawn(command, env);
  if (refusal !== undefined) {
    return refusal;
  }
  // `Bun.spawn` THROWS synchronously when the binary does not exist, where `child_process` emits
  // an "error" event instead. Both branches must honour the same contract — resolve with a
  // non-zero code, never reject — or a caller's behaviour would depend on the runtime.
  try {
    const proc = Bun.spawn([...command], {
      env: childEnv,
      stdout: "pipe",
      stderr: "pipe",
    });
    const code = await proc.exited;
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    return { code, stdout, stderr };
  } catch (e) {
    return { code: 1, stdout: "", stderr: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Whether `Bun.spawn` is usable on the given global.
 *
 * Takes the global as a PARAMETER rather than reading `globalThis` directly, because Bun defines
 * its global as non-writable AND non-configurable — it cannot be stubbed or redefined, so the
 * "absent" side is otherwise unreachable from a suite that runs under Bun. That side is the one
 * the standalone npx artifact always takes, so it must be exercisable.
 */
export function detectBunSpawn(g: unknown = globalThis): boolean {
  const bun = (g as { Bun?: { spawn?: unknown } }).Bun;
  return typeof bun?.spawn === "function";
}

/** The shape both implementations share, and what `selectSpawnImpl` hands back. */
export type SpawnImpl = (
  command: readonly string[],
  env: Record<string, string | undefined>,
) => Promise<SpawnResult>;

/**
 * Which implementation a given global calls for.
 *
 * Returning the FUNCTION rather than taking a `useBun` flag is deliberate: a boolean selector
 * argument makes one entry point mean two things, and the two implementations are already exported
 * as the two things it selected between. Injecting the global — for the same
 * non-writable/non-configurable reason `detectBunSpawn` takes one — is what keeps the Node side
 * reachable from a suite that runs under Bun.
 */
export function selectSpawnImpl(g: unknown = globalThis): SpawnImpl {
  return detectBunSpawn(g) ? spawnViaBun : spawnViaNode;
}

/**
 * Spawn a CLI and collect its output, on Bun or Node.
 *
 * Detection happens at CALL time, not module load, so a test that swaps `Bun.spawn` is still
 * honoured. That is not incidental: `cloudwatch/test/tools.test.ts` stubs `Bun.spawn` globally, and
 * routing unconditionally through Node made it spawn a real `aws` and hang the suite.
 *
 * Never rejects: a spawn failure resolves with a non-zero code, matching the previous behaviour.
 * So does a REFUSED spawn — on Windows, an argument cmd.exe would act on, for a program that may
 * start a batch file — whose stderr says why and that nothing was run.
 */
export function nimbusSpawn(
  command: readonly string[],
  env: Record<string, string | undefined>,
): Promise<SpawnResult> {
  return selectSpawnImpl()(command, env);
}
