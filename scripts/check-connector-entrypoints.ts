#!/usr/bin/env bun
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { stripComments } from "./strip-comments.ts";

export const CONNECTORS_DIR = resolve(import.meta.dir, "..", "connectors");

export interface EntrypointViolation {
  readonly connector: string;
  readonly reason: string;
}

const GUARD_RE = /\bimport\.meta\.main\b/;
const EXPORT_RE = /export\s+async\s+function\s+startConnector\s*\(/;

/**
 * A connector `server.ts` that guards its startup with `import.meta.main` is invisible to the
 * bundled-connector registry: the guard is false under an import, so the module loads, starts
 * nothing and the process exits 0 in silence. Such a module MUST export `startConnector()` so the
 * registry can start it explicitly.
 */
export function checkConnectorEntrypoints(dir: string = CONNECTORS_DIR): EntrypointViolation[] {
  const out: EntrypointViolation[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const server = join(dir, entry.name, "src", "server.ts");
    if (!existsSync(server)) continue;
    const src = stripComments(readFileSync(server, "utf8"));
    if (!GUARD_RE.test(src)) continue;
    if (EXPORT_RE.test(src)) continue;
    out.push({
      connector: entry.name,
      reason:
        "guards startup with import.meta.main but does not export startConnector(): the bundled " +
        "registry would import it, start nothing, and exit 0 in silence",
    });
  }
  return out;
}

/**
 * Print the verdict and return the process exit code.
 *
 * Split out of the `import.meta.main` block so it can be tested. That guard is false under an
 * import, so anything inside it is unreachable to every in-process test — the same reason
 * `standalone/src/bin.ts` was split from `launcher.ts`. Leaving the reporting inline meant either
 * an uncoverable branch or a coverage exclusion over the whole file, and the file is the audit.
 */
export function report(violations: readonly EntrypointViolation[]): number {
  for (const v of violations) {
    console.error(`::error file=connectors/${v.connector}/src/server.ts::${v.reason}`);
  }
  console.log(
    violations.length === 0
      ? "connector entrypoints: ok"
      : `connector entrypoints: ${violations.length} violation(s)`,
  );
  return violations.length > 0 ? 1 : 0;
}

if (import.meta.main) {
  process.exit(report(checkConnectorEntrypoints()));
}
