// Decides, without any secret, whether the registry index still has to be re-signed to name the
// liveness public key. Imports Node builtins only (pinned by its test), like publish-registry.ts.
import { appendFileSync, readFileSync } from "node:fs";

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

if (import.meta.main) {
  try {
    const { needed } = checkLivenessKey(
      readFileSync("registry/index.json", "utf8"),
      process.env["KEY"] ?? "",
    );
    const out = process.env["GITHUB_OUTPUT"];
    if (out) appendFileSync(out, `needed=${needed}\n`);
    console.log(
      needed
        ? "the index does not name this liveness key yet; the set-key job will run"
        : "the index already names this liveness key; nothing to do",
    );
  } catch (error) {
    console.log(`::error::${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
