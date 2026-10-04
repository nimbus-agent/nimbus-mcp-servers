import { nimbusSpawn } from "./nimbus-spawn.ts";

export type RunCliJsonResult = { ok: true; data: unknown } | { ok: false; message: string };

/**
 * Spawn `command`. An empty command, or a non-zero exit, becomes the one failure message every
 * caller reports: `<binary> exited <code>: <first 500 chars of stderr>`.
 */
async function spawnChecked(
  command: readonly string[],
  env: Record<string, string | undefined>,
): Promise<{ ok: true; stdout: string } | { ok: false; message: string }> {
  if (command.length === 0) {
    return { ok: false, message: "empty command" };
  }
  const { code, stdout, stderr } = await nimbusSpawn(command, env);
  if (code !== 0) {
    return {
      ok: false,
      message: `${command[0] ?? "cli"} exited ${String(code)}: ${stderr.slice(0, 500)}`,
    };
  }
  return { ok: true, stdout };
}

export async function runCliOk(
  command: readonly string[],
  env: Record<string, string | undefined>,
): Promise<{ ok: true } | { ok: false; message: string }> {
  const r = await spawnChecked(command, env);
  return r.ok ? { ok: true } : r;
}

/** {@link runCliOk}, throwing its failure message instead of returning it. */
export async function runCliOkThrowing(
  command: readonly string[],
  env: Record<string, string | undefined>,
): Promise<void> {
  const r = await runCliOk(command, env);
  if (!r.ok) {
    throw new Error(r.message);
  }
}

export async function runCliJson(
  command: readonly string[],
  env: Record<string, string | undefined>,
): Promise<RunCliJsonResult> {
  const r = await spawnChecked(command, env);
  if (!r.ok) {
    return r;
  }
  const trimmed = r.stdout.trim();
  if (trimmed === "") {
    return { ok: true, data: null };
  }
  try {
    return { ok: true, data: JSON.parse(trimmed) as unknown };
  } catch {
    return { ok: false, message: `invalid JSON from CLI: ${r.stdout.slice(0, 200)}` };
  }
}

/**
 * {@link runCliJson}, throwing its failure message instead of returning it. Resolves to the parsed
 * JSON, or `null` when the command printed nothing.
 */
export async function runCliJsonThrowing(
  command: readonly string[],
  env: Record<string, string | undefined>,
): Promise<unknown> {
  const r = await runCliJson(command, env);
  if (!r.ok) {
    throw new Error(r.message);
  }
  return r.data;
}
