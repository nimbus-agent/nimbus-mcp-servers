/**
 * `shared/nimbus-spawn.ts` is the only shipped file that starts a process.
 *
 * That chokepoint applies the rule every spawned argument must meet on every platform — on Windows,
 * refusing an argument cmd.exe would act on when the program may start a batch file — so the rule
 * holds for every connector only while nothing else spawns. This reads every shipped source file,
 * comments stripped, and fails any other that names a process-spawning API: a connector reaching
 * for `Bun.spawn` or `node:child_process` itself would otherwise skip the check silently, and look
 * exactly like one that is covered.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { stripComments } from "./strip-comments.ts";

const ROOT = join(fileURLToPath(import.meta.url), "..", "..");

/** The one file allowed to start a process. */
const CHOKEPOINT = "shared/nimbus-spawn.ts";

/** Each way a module can start a process, by name. */
const SPAWN_APIS: readonly (readonly [string, RegExp])[] = [
  ["node:child_process", /["'](?:node:)?child_process["']/],
  ["node:cluster", /(?:from|import|require)\s*\(?\s*["'](?:node:)?cluster["']/],
  ["Bun.spawn", /\bBun\s*(?:\.\s*spawn(?:Sync)?\b|\[\s*["']spawn)/],
  ["Bun's shell", /\bBun\s*\.\s*\$|import\s*\{[^}]*\$[^}]*\}\s*from\s*["']bun["']/],
];

/** The process-spawning APIs `source` names outside its comments. */
function spawnApisIn(source: string): string[] {
  const code = stripComments(source);
  return SPAWN_APIS.filter(([, pattern]) => pattern.test(code)).map(([name]) => name);
}

/** Every file the package ships as source, relative to the root with `/` separators. */
function shippedSources(): string[] {
  const files: string[] = [];
  for (const pattern of [
    "connectors/*/src/**/*.{ts,js,mjs,cjs}",
    "shared/**/*.{ts,js,mjs,cjs}",
    "standalone/src/**/*.{ts,js,mjs,cjs}",
  ]) {
    for (const file of new Bun.Glob(pattern).scanSync({ cwd: ROOT })) {
      const rel = file.replaceAll("\\", "/");
      if (!/\.test\.[cm]?[jt]s$/.test(rel)) {
        files.push(rel);
      }
    }
  }
  return files.sort();
}

describe("the spawn chokepoint", () => {
  const sources = shippedSources();

  test("scans the whole shipped tree, not an empty one", () => {
    // A scan that found nothing to read would pass every assertion below.
    expect(sources.length).toBeGreaterThan(94 * 2);
    expect(sources).toContain(CHOKEPOINT);
    expect(sources).toContain("connectors/azure/src/tools.ts");
    expect(sources).toContain("standalone/src/launcher.ts");
  });

  test("recognises the chokepoint's own spawns, so a miss elsewhere means something", () => {
    expect(spawnApisIn(readFileSync(join(ROOT, CHOKEPOINT), "utf8"))).toEqual([
      "node:child_process",
      "Bun.spawn",
    ]);
  });

  test("is the only shipped file that names a process-spawning API", () => {
    const spawners = sources
      .map((file) => ({ file, apis: spawnApisIn(readFileSync(join(ROOT, file), "utf8")) }))
      .filter((s) => s.apis.length > 0)
      .map((s) => s.file);
    expect(spawners).toEqual([CHOKEPOINT]);
  });
});

describe("spawnApisIn", () => {
  test("finds each way of starting a process", () => {
    expect(spawnApisIn('import { spawn } from "node:child_process";')).toEqual([
      "node:child_process",
    ]);
    expect(spawnApisIn("const cp = require('child_process');")).toEqual(["node:child_process"]);
    expect(spawnApisIn('const { execFile } = await import("child_process");')).toEqual([
      "node:child_process",
    ]);
    expect(spawnApisIn('import cluster from "node:cluster";')).toEqual(["node:cluster"]);
    expect(spawnApisIn("const p = Bun.spawn(['az']);")).toEqual(["Bun.spawn"]);
    expect(spawnApisIn("Bun.spawnSync(['az']);")).toEqual(["Bun.spawn"]);
    expect(spawnApisIn("globalThis.Bun['spawn'](['az']);")).toEqual(["Bun.spawn"]);
    expect(spawnApisIn('import { $ } from "bun";')).toEqual(["Bun's shell"]);
    expect(spawnApisIn("await Bun.$`az login`;")).toEqual(["Bun's shell"]);
  });

  test("ignores a mention in a comment, and the word in an ordinary string", () => {
    expect(spawnApisIn("// spawned through Bun.spawn by nimbus-spawn.ts\nexport {};")).toEqual([]);
    expect(spawnApisIn("/* node:child_process would reject a .cmd */ export {};")).toEqual([]);
    expect(spawnApisIn('const kinds = ["cluster", "function", "instance"];')).toEqual([]);
  });
});
