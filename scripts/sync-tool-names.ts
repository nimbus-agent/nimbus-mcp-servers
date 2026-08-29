#!/usr/bin/env bun
/**
 * Keep each connector's `*_TOOL_NAMES` export in step with what its registrar
 * actually registers.
 *
 * The constant is what several tests compare the live surface against, so it is
 * only worth having if it is DERIVED from the code rather than typed out beside
 * it. `bun run sync:tool-names` rewrites the stale ones; `--check` reports them
 * without writing, which is what the gate test runs.
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { resetConnectorModeForTests, setConnectorMode } from "../shared/connector-mode.ts";
import { captureTools } from "./connector-tool-harness.ts";

const ROOT = join(fileURLToPath(import.meta.url), "..", "..");

/**
 * A `*_TOOL_NAMES` export written as a plain list of string literals.
 *
 * Deliberately does not match a DERIVED list — readwise builds its names from
 * `collectionToolNames(...)`, which is already in step with the code by
 * construction, and replacing it with a literal would be a regression.
 */
const NAMES_DECL = /export const ([A-Z0-9_]+_TOOL_NAMES) = \[(?:\s*"[a-z0-9_]+",)*\s*\] as const;/s;

/** One connector whose declared names disagree with its registered ones. */
export interface ToolNamesDrift {
  readonly connector: string;
  readonly file: string;
  readonly declared: readonly string[];
  readonly registered: readonly string[];
}

/**
 * The module holding a connector's `*_TOOL_NAMES`: `src/tools.ts` when it has
 * one, otherwise an `import.meta.main`-guarded `src/server.ts`. An unguarded
 * entry point is skipped — importing it would open a stdio transport.
 */
function namesFile(root: string, id: string): string | undefined {
  for (const file of ["tools.ts", "server.ts"]) {
    const path = join(root, "connectors", id, "src", file);
    if (!existsSync(path)) {
      continue;
    }
    const src = readFileSync(path, "utf8");
    if (file === "server.ts" && !src.includes("import.meta.main")) {
      return undefined;
    }
    if (src.includes("_TOOL_NAMES")) {
      return path;
    }
  }
  return undefined;
}

function declaration(
  src: string,
): { match: string; constant: string; names: string[] } | undefined {
  const decl = NAMES_DECL.exec(src);
  if (decl?.[1] === undefined) {
    return undefined;
  }
  return {
    match: decl[0],
    constant: decl[1],
    names: [...decl[0].matchAll(/"([a-z0-9_]+)"/g)].map((m) => m[1] ?? ""),
  };
}

function render(constant: string, names: readonly string[]): string {
  const entries = names.map((n) => `  "${n}",\n`).join("");
  return `export const ${constant} = [\n${entries}] as const;`;
}

/**
 * Compare every connector's declared names against its registered ones.
 *
 * Names are compared in REGISTRATION order, not sorted: the constant is written
 * in the order the tools are registered and several connectors' tests assert
 * that order.
 */
export async function findToolNamesDrift(root: string = ROOT): Promise<ToolNamesDrift[]> {
  const drift: ToolNamesDrift[] = [];
  resetConnectorModeForTests();
  setConnectorMode("gateway");
  try {
    for (const entry of readdirSync(join(root, "connectors"), { withFileTypes: true })) {
      if (!entry.isDirectory()) {
        continue;
      }
      const path = namesFile(root, entry.name);
      if (path === undefined) {
        continue;
      }
      const src = readFileSync(path, "utf8");
      const decl = declaration(src);
      if (decl === undefined) {
        continue;
      }
      const mod = (await import(path)) as Record<string, unknown>;
      const register = Object.entries(mod).find(
        ([name, value]) =>
          /^register[A-Za-z]+Tools$/.test(name) && typeof value === "function" && value.length <= 2,
      )?.[1];
      if (register === undefined) {
        continue;
      }
      let registered: string[];
      try {
        registered = captureTools(
          register as Parameters<typeof captureTools>[0],
        ).registrationOrder();
      } catch {
        // A registrar that needs injected collaborators cannot be driven here;
        // its own test covers it.
        continue;
      }
      if (registered.join(" ") !== decl.names.join(" ")) {
        drift.push({ connector: entry.name, file: path, declared: decl.names, registered });
      }
    }
  } finally {
    resetConnectorModeForTests();
  }
  return drift;
}

/** Rewrite the stale declarations. Returns the connectors that were updated. */
export async function syncToolNames(root: string = ROOT): Promise<string[]> {
  const drift = await findToolNamesDrift(root);
  for (const item of drift) {
    const src = readFileSync(item.file, "utf8");
    const decl = declaration(src);
    if (decl === undefined) {
      continue;
    }
    writeFileSync(
      item.file,
      src.replace(decl.match, render(decl.constant, item.registered)),
      "utf8",
    );
  }
  return drift.map((d) => d.connector);
}

if (import.meta.main) {
  const drift = await findToolNamesDrift();
  if (process.argv.includes("--check")) {
    for (const item of drift) {
      process.stdout.write(
        `::error file=${item.file}::${item.connector} declares [${item.declared.join(", ")}] but registers [${item.registered.join(", ")}]\n`,
      );
    }
    process.stdout.write(
      drift.length === 0
        ? "tool names: ok\n"
        : `tool names: ${String(drift.length)} out of date — run \`bun run sync:tool-names\`\n`,
    );
    process.exit(drift.length === 0 ? 0 : 1);
  }
  const updated = await syncToolNames();
  process.stdout.write(
    updated.length === 0
      ? "tool names: already in sync\n"
      : `tool names: updated ${updated.join(", ")}\n`,
  );
}
