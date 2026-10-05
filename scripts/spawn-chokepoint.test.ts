/**
 * `shared/nimbus-spawn.ts` is the only shipped file that can start a process.
 *
 * That chokepoint applies the rule every spawned argument must meet on every platform — on Windows,
 * refusing an argument cmd.exe would act on when the program may start a batch file — so the rule
 * holds for every connector only while nothing else spawns. This reads every shipped source file
 * through Bun's own transpiler, so a comment, a string or a type never counts and an import counts
 * in every form the parser knows, and fails any other file that:
 *
 *  - imports a module that can start a process, in any form — `import`, `export … from`, a dynamic
 *    `import()` or `require()`, in any quote style: `bun`, whose exports include `spawn`,
 *    `spawnSync` and `$`; `bun:ffi`; and `child_process` and `cluster`, with or without `node:`;
 *  - names `child_process`, `node:cluster` or `bun:ffi` as a string anywhere, as
 *    `createRequire(…)("child_process")` or `process.getBuiltinModule(…)` would, or uses either of
 *    those two loaders at all;
 *  - refers to the `Bun` global in any way — `Bun.spawn`, `const { spawn } = Bun`, `Bun?.spawn`,
 *    `globalThis.Bun` — found by having the transpiler replace every reference to it, so a local
 *    that shadows it, or the word in a string, is not one; or reaches it by name, as
 *    `globalThis["Bun"]` or `g.Bun` would;
 *  - calls `process.execve`, `process.dlopen` or `process.binding`.
 *
 * No other shipped file needs the `Bun` global: the connectors run under Node too, where it does not
 * exist, and the chokepoint is what handles both. What a source scan cannot see is a module name
 * assembled at run time — `import(name)`, `require(name)` — or a native addon; review catches those.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(import.meta.url), "..", "..");

/** The one file allowed to start a process. */
const CHOKEPOINT = "shared/nimbus-spawn.ts";

/** What the transpiler writes in place of every reference to the `Bun` global. */
const BUN_GLOBAL = "__nimbus_spawn_chokepoint_bun_global__";

const transpiler = new Bun.Transpiler({
  loader: "ts",
  define: { Bun: BUN_GLOBAL, "globalThis.Bun": BUN_GLOBAL },
});

/** The modules through which a module can start a process. */
const SPAWNING_MODULES = [
  "bun",
  "bun:ffi",
  "child_process",
  "node:child_process",
  "cluster",
  "node:cluster",
] as const;

/**
 * The spawning modules whose name, as a string, means nothing else. `cluster` and `bun` are not
 * among them: `"cluster"` is an AWS scope kind in the aws connector.
 */
const UNAMBIGUOUS_MODULE_NAMES = ["child_process", "node:child_process", "node:cluster", "bun:ffi"];

function asStringLiteral(text: string): RegExp {
  const escaped = text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(["'\`])${escaped}\\1`);
}

/** Every way `source` could start a process without the chokepoint, named. */
function spawnRoutesIn(source: string): string[] {
  const routes: string[] = [];
  // The transpiler refuses a `#!` line, which an entry point such as the package bin starts with.
  const program = source.replace(/^#![^\n]*/, "");
  const imported = new Set(transpiler.scanImports(program).map((i) => i.path));
  const code = transpiler.transformSync(program);
  for (const module of SPAWNING_MODULES) {
    if (imported.has(module)) {
      routes.push(`imports ${module}`);
    } else if (UNAMBIGUOUS_MODULE_NAMES.includes(module) && asStringLiteral(module).test(code)) {
      routes.push(`names ${module}`);
    }
  }
  if (/\b(?:createRequire|getBuiltinModule)\b/.test(code)) {
    routes.push("loads a module by name");
  }
  if (code.includes(BUN_GLOBAL)) {
    routes.push("uses the Bun global");
  }
  if (/(?:\.|\?\.)\s*Bun\b/.test(code) || asStringLiteral("Bun").test(code)) {
    routes.push("reaches the Bun global by name");
  }
  if (/\bprocess\s*(?:\.|\?\.)\s*(?:execve|dlopen|binding)\b/.test(code)) {
    routes.push("uses a process primitive");
  }
  return routes;
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
    expect(spawnRoutesIn(readFileSync(join(ROOT, CHOKEPOINT), "utf8"))).toEqual([
      "imports node:child_process",
      "uses the Bun global",
      "reaches the Bun global by name",
    ]);
  });

  test("is the only shipped file with a way to start a process", () => {
    const spawners = sources
      .map((file) => ({ file, routes: spawnRoutesIn(readFileSync(join(ROOT, file), "utf8")) }))
      .filter((s) => s.routes.length > 0);
    expect(spawners.map((s) => s.file)).toEqual([CHOKEPOINT]);
  });
});

describe("spawnRoutesIn", () => {
  test.each([
    ['import { spawn } from "node:child_process";', "imports node:child_process"],
    ["const cp = require('child_process');", "imports child_process"],
    ["const cp = require(`child_process`);", "imports child_process"],
    ['const { execFile } = await import("child_process");', "imports child_process"],
    ["const m = await import(`node:child_process`);", "imports node:child_process"],
    ['export * from "node:child_process";', "imports node:child_process"],
    ['import cluster from "node:cluster";', "imports node:cluster"],
    ["const c = require('cluster'); c.fork();", "imports cluster"],
    ['import { spawn } from "bun"; spawn(["az"]);', "imports bun"],
    ['import { spawn as run } from "bun"; run(["az"]);', "imports bun"],
    ['import * as bun from "bun"; bun.spawn(["az"]);', "imports bun"],
    ['import B from "bun"; B.$`az`;', "imports bun"],
    ['export { spawnSync } from "bun";', "imports bun"],
    ['import { dlopen } from "bun:ffi";', "imports bun:ffi"],
  ])("finds an import: %s", (source, route) => {
    expect(spawnRoutesIn(source)).toEqual([route]);
  });

  test.each([
    ['const p = Bun.spawn(["az"]);'],
    ['Bun.spawnSync(["az"]);'],
    ["await Bun.$`az login`;"],
    ['Bun . spawn(["az"]);'],
    ['const { spawn } = Bun; spawn(["az"]);'],
    ['Bun?.spawn(["az"]);'],
    ['Bun["spawn"](["az"]);'],
    ['const B = Bun; B.spawn(["az"]);'],
    ['globalThis.Bun.spawn(["az"]);'],
    ['const B = globalThis.Bun; B.spawn(["az"]);'],
    ["start(Bun);"],
    ['if (typeof Bun !== "undefined") {}'],
  ])("finds the Bun global used directly: %s", (source) => {
    expect(spawnRoutesIn(source)).toEqual(["uses the Bun global"]);
  });

  test.each([
    ['globalThis["Bun"].spawn(["az"]);'],
    ['globalThis?.Bun?.spawn(["az"]);'],
    ['const g = globalThis; g.Bun.spawn(["az"]);'],
    ["const G = self; G?.Bun;"],
  ])("finds the Bun global reached by name: %s", (source) => {
    expect(spawnRoutesIn(source)).toEqual(["reaches the Bun global by name"]);
  });

  test("finds a builtin loaded by name, past what an import scan sees", () => {
    expect(
      spawnRoutesIn(
        'import { createRequire } from "node:module"; createRequire(import.meta.url)("child_process");',
      ),
    ).toEqual(["names child_process", "loads a module by name"]);
    expect(spawnRoutesIn('process.getBuiltinModule("node:child_process");')).toEqual([
      "names node:child_process",
      "loads a module by name",
    ]);
    expect(spawnRoutesIn('process.getBuiltinModule("cluster");')).toEqual([
      "loads a module by name",
    ]);
  });

  test("finds the process primitives that start or load a program", () => {
    expect(spawnRoutesIn('process.execve("/bin/sh", []);')).toEqual(["uses a process primitive"]);
    expect(spawnRoutesIn('process.dlopen(module, "x.node");')).toEqual([
      "uses a process primitive",
    ]);
    expect(spawnRoutesIn('process.binding("spawn_sync");')).toEqual(["uses a process primitive"]);
  });

  test("ignores a comment, a string, a type, a shadowing local and an ordinary word", () => {
    for (const source of [
      "// spawned through Bun.spawn by nimbus-spawn.ts\nexport {};",
      "/* node:child_process would reject a .cmd */ export {};",
      'import type { Subprocess } from "bun"; export type S = Subprocess;',
      'const kinds = ["cluster", "function", "instance"];',
      'const note = "Bun.spawn is the chokepoint\'s; Bun runs this";',
      "export function f(Bun: { spawn: () => void }) { return Bun.spawn; }",
      "let x: typeof Bun.spawn | undefined;",
      'const o = { Bun: 1 }; export const bundle = "bun";',
    ]) {
      expect({ source, routes: spawnRoutesIn(source) }).toEqual({ source, routes: [] });
    }
  });
});
