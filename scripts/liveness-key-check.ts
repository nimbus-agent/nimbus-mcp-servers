// Decides, without any secret, whether the registry index still has to be re-signed to name the
// liveness public key. Imports Node builtins only (pinned by its test), like publish-registry.ts.
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";

const VARIABLE = "NIMBUS_REGISTRY_LIVENESS_PUBLIC_KEY";
const KEY_SHAPE = /^[A-Za-z0-9+/]{43}=$/;

export function checkLivenessKey(indexText: string, key: string): { needed: boolean } {
  if (!KEY_SHAPE.test(key)) {
    throw new Error(
      `repository variable ${VARIABLE} is unset or not a base64 Ed25519 public key (44 characters ending in "=")`,
    );
  }
  let index: unknown;
  try {
    index = JSON.parse(indexText);
  } catch {
    throw new Error("registry/index.json is not valid JSON");
  }
  if (typeof index !== "object" || index === null || Array.isArray(index)) {
    throw new Error("registry/index.json is not a JSON object");
  }
  const current = (index as Record<string, unknown>)["livenessKey"];
  if (current !== undefined && typeof current !== "string") {
    throw new Error("registry/index.json has a livenessKey that is not a string");
  }
  return { needed: current !== key };
}

/**
 * The script's whole behaviour, in process so tests cover it: read `<cwd>/registry/index.json`,
 * decide, append `needed=` to `GITHUB_OUTPUT` when set, and log one line. Returns the exit code.
 */
export function runLivenessKeyCheck(
  env: Record<string, string | undefined>,
  cwd: string,
  log: (line: string) => void,
): number {
  try {
    const { needed } = checkLivenessKey(
      readFileSync(join(cwd, "registry", "index.json"), "utf8"),
      env["KEY"] ?? "",
    );
    const out = env["GITHUB_OUTPUT"];
    if (out) appendFileSync(out, `needed=${needed}\n`);
    log(
      needed
        ? "the index does not name this liveness key yet; the set-key job will run"
        : "the index already names this liveness key; nothing to do",
    );
    return 0;
  } catch (error) {
    log(`::error::${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

if (import.meta.main) process.exit(runLivenessKeyCheck(process.env, process.cwd(), console.log));
