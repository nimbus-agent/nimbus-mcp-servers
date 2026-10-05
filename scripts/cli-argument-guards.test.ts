/**
 * No caller-supplied value reaches a spawned CLI's argv unchecked.
 *
 * Swept, not listed: every connector that spawns a CLI is found from its imports, every tool it
 * registers is called, and every string argument is tried with values each CLI would misread. For
 * each tool the sweep first calls it with ordinary values and records which argument reached which
 * CLI's argv — so a refusal below is measured against an argument known to arrive, and cannot pass
 * because the argument was never used. Then, one argument at a time:
 *
 *  - an argument that reached argv must be REFUSED with nothing spawned, for a value starting with
 *    `-` (read as a flag: `--kubeconfig=<path>` as a pod name runs that kubeconfig's exec plugin),
 *    one with a control character, one over 1024 characters, and — for the CLI it reached — a value
 *    `aws` would replace by a file or URL (`file://`, `fileb://`, `http(s)://`, shorthand `@=`) or one `az`
 *    would replace by a file (`@<path>`, `=@`);
 *  - an argument that did not reach argv may be anything, and must still not reach argv.
 *
 * Found unchecked by this sweep and fixed with it: kubectl positionals in kubernetes and gcp, the
 * gcloud positionals in gcp, every azure argument, and every aws and iac one.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resetConnectorModeForTests, setConnectorMode } from "../shared/connector-mode.ts";
import {
  type CapturedTools,
  type ConnectorRegistrar,
  captureTools,
  stubFetch,
  stubSpawn,
  withEnv,
} from "./connector-tool-harness.ts";
import { fixtureFor, type ParsableSchema } from "./tool-arg-fixture.ts";

const ROOT = join(fileURLToPath(import.meta.url), "..", "..");
const CONNECTORS = join(ROOT, "connectors");

/**
 * The connectors this sweep must find. Pinned so that a broken discovery fails here rather than
 * sweeping nothing; a twelfth connector that spawns a CLI is swept the day it lands and then
 * fails this list until it is added to it.
 */
const EXPECTED_SPAWNING = [
  "athena",
  "aws",
  "azure",
  "bigquery",
  "cloud-logging",
  "cloudwatch",
  "gcp",
  "iac",
  "kubernetes",
  "sagemaker",
  "vertex-ai",
];

/** What a connector reads at call time, held fixed so its argv is the same on every machine. */
const CALL_ENV: Record<string, string | undefined> = {
  KUBECONFIG: "/nonexistent/kubeconfig",
  KUBE_CONTEXT: undefined,
  BIGQUERY_PROJECT: "nimbus-sweep-project",
  GOOGLE_CLOUD_PROJECT: undefined,
  VERTEX_AI_REGION: undefined,
};

/** Each class of value a CLI would misread, and the CLIs it is hostile to (`*` for every one). */
const HOSTILE: readonly { readonly kind: string; readonly cli: string; readonly value: string }[] =
  [
    { kind: "flag", cli: "*", value: "--kubeconfig=/tmp/nimbus-sweep-flag" },
    { kind: "flag", cli: "*", value: "-nimbus-sweep" },
    { kind: "control", cli: "*", value: `nimbus${String.fromCharCode(0x0a)}sweep` },
    { kind: "length", cli: "*", value: "x".repeat(1025) },
    { kind: "aws-load", cli: "aws", value: "file:///etc/hosts" },
    { kind: "aws-load", cli: "aws", value: "fileb:///etc/hosts" },
    { kind: "aws-load", cli: "aws", value: "http://169.254.169.254/latest/meta-data/" },
    { kind: "aws-load", cli: "aws", value: "https://example.invalid/nimbus-sweep" },
    { kind: "aws-shorthand", cli: "aws", value: "Key@=file:///etc/hosts" },
    { kind: "az-load", cli: "az", value: "@/etc/hosts" },
    { kind: "az-load", cli: "az", value: "@-" },
    { kind: "az-load", cli: "az", value: "nimbus=@/etc/hosts" },
    { kind: "az-load", cli: "az", value: "=@/etc/hosts" },
    { kind: "az-load", cli: "az", value: "=@-" },
  ];

/**
 * Arguments allowed to reach argv despite a hostile class, each with the reason. Not a convenience
 * list: an entry must still describe an argument that reaches argv, or this sweep fails it as stale.
 */
const ALLOWED: readonly {
  readonly tool: string;
  readonly field: string;
  readonly kinds: readonly string[];
  readonly reason: string;
}[] = [
  {
    tool: "iac_cloudformation_deploy",
    field: "templateBody",
    kinds: ["control", "length", "aws-shorthand"],
    reason:
      "a template body is a document: it spans lines and runs past 1024 characters, and as a string parameter it is not read as shorthand syntax, so only a leading dash and the aws loading prefixes are refused",
  },
];

/** The one file that starts a process, held to that by `spawn-chokepoint.test.ts`. */
const SPAWN_CHOKEPOINT = join(ROOT, "shared", "nimbus-spawn.ts");

const transpiler = new Bun.Transpiler({ loader: "ts" });

/** The relative specifiers `file` imports — statically, dynamically or by `require` — memoised. */
const relativeImports = new Map<string, readonly string[]>();
function relativeImportsOf(file: string): readonly string[] {
  let found = relativeImports.get(file);
  if (found === undefined) {
    // The transpiler refuses a `#!` line, which an entry point may start with.
    const source = readFileSync(file, "utf8").replace(/^#![^\n]*/, "");
    found = transpiler
      .scanImports(source)
      .map((i) => i.path)
      .filter((path) => path.startsWith("."));
    relativeImports.set(file, found);
  }
  return found;
}

/** The source file a relative specifier in `from` names: as written, or with `.ts` added. */
function resolveImport(from: string, specifier: string): string {
  const base = resolve(dirname(from), specifier);
  for (const candidate of [base, `${base}.ts`]) {
    if (statSync(candidate, { throwIfNoEntry: false })?.isFile() === true) {
      return candidate;
    }
  }
  throw new Error(`${from} imports ${specifier}, which names no file`);
}

/**
 * Whether `file`'s imports, followed through every relative specifier, reach `target`. A type-only
 * import is not followed: it cannot call anything. An import that names no file fails the sweep
 * rather than ending the search early, so a connector cannot drop out of it unnoticed.
 */
function importsReach(file: string, target: string, seen = new Set<string>()): boolean {
  if (file === target) {
    return true;
  }
  if (seen.has(file)) {
    return false;
  }
  seen.add(file);
  return relativeImportsOf(file).some(
    (specifier) =>
      !specifier.endsWith(".json") && importsReach(resolveImport(file, specifier), target, seen),
  );
}

/**
 * Connectors whose sources reach the spawn chokepoint through their imports, however indirectly:
 * through `run-cli-json.ts`, `cli-json-kit.ts` or any shared helper written later.
 */
function spawningConnectors(): string[] {
  return readdirSync(CONNECTORS, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .filter((id) => {
      const src = join(CONNECTORS, id, "src");
      const seen = new Set<string>();
      return [...new Bun.Glob("**/*.{ts,js,mjs,cjs}").scanSync({ cwd: src })]
        .filter((file) => !/\.test\.[cm]?[jt]s$/.test(file))
        .some((file) => importsReach(join(src, file), SPAWN_CHOKEPOINT, seen));
    })
    .sort();
}

async function registrarOf(id: string): Promise<ConnectorRegistrar> {
  const mod = (await import(join(CONNECTORS, id, "src", "tools.ts"))) as Record<string, unknown>;
  const entry = Object.entries(mod).find(
    ([name, value]) => /^register[A-Za-z]+Tools$/.test(name) && typeof value === "function",
  );
  if (entry === undefined) {
    throw new Error(`${id}: no register…Tools export in src/tools.ts`);
  }
  return entry[1] as ConnectorRegistrar;
}

/**
 * Arguments the tool's schema accepts, every optional string included, each string set to a value
 * that names its field — so a value found in argv says which argument put it there.
 */
function sweepArgs(name: string, schema: ParsableSchema): Record<string, unknown> {
  const base = fixtureFor(schema);
  if (base === undefined) {
    throw new Error(`${name}: no generic arguments satisfy its schema`);
  }
  const shape = (schema as { shape?: Record<string, unknown> }).shape ?? {};
  const args: Record<string, unknown> = { ...base };
  for (const field of Object.keys(shape)) {
    const named = `nimbus-sweep-${field}`;
    if (typeof args[field] === "string" || !(field in args)) {
      const tried = { ...args, [field]: named };
      if (schema.safeParse(tried).success) {
        args[field] = named;
      }
    }
  }
  return args;
}

interface Run {
  readonly refused: boolean;
  readonly argv: readonly (readonly string[])[];
}

async function run(
  tools: CapturedTools,
  name: string,
  args: Record<string, unknown>,
): Promise<Run> {
  const spawn = stubSpawn({ stdout: "{}" });
  const http = stubFetch({ body: "{}" });
  try {
    let refused = false;
    await withEnv(CALL_ENV, async () => {
      try {
        await tools.call(name, args);
      } catch {
        refused = true;
      }
    });
    return { refused, argv: spawn.calls.map((c) => c.command) };
  } finally {
    http.restore();
    spawn.restore();
  }
}

/**
 * What is wrong with how tool `name` treats a hostile value in `field`, given the CLIs an ordinary
 * value of it reached (`clis`, empty when it reached none).
 *
 * An argument that reached a CLI must be refused, before anything spawns, for each value hostile
 * to that CLI; a value hostile only to ANOTHER CLI is not tried, since `file://x` as a gcloud
 * project is read as written and refused by gcloud. An argument that reached no CLI is tried with
 * every hostile value, and must not let any of them reach argv either.
 */
async function fieldViolations(
  tools: CapturedTools,
  name: string,
  args: Record<string, unknown>,
  field: string,
  clis: readonly string[],
  allowedUsed: Set<(typeof ALLOWED)[number]>,
): Promise<string[]> {
  const found: string[] = [];
  for (const hostile of HOSTILE) {
    const hostileHere = clis.length > 0 && (hostile.cli === "*" || clis.includes(hostile.cli));
    if (clis.length > 0 && !hostileHere) {
      continue;
    }
    const allowed = ALLOWED.find(
      (a) => a.tool === name && a.field === field && a.kinds.includes(hostile.kind),
    );
    if (allowed !== undefined && hostileHere) {
      allowedUsed.add(allowed);
      continue;
    }
    const attempt = await run(tools, name, { ...args, [field]: hostile.value });
    const leaked = clisCarrying(attempt.argv, hostile.value);
    if (leaked.length > 0) {
      found.push(`${name}.${field}: a ${hostile.kind} value reached ${leaked.join(", ")}`);
    } else if (hostileHere && (!attempt.refused || attempt.argv.length > 0)) {
      found.push(`${name}.${field}: a ${hostile.kind} value was not refused before every spawn`);
    }
  }
  return found;
}

/** The CLIs whose argv carries `value` in some element. */
function clisCarrying(argv: readonly (readonly string[])[], value: string): string[] {
  return argv
    .filter((command) => command.some((arg) => arg.includes(value)))
    .map((command) => basename(command[0] ?? "").replace(/\.(?:cmd|exe|bat)$/i, ""));
}

describe("caller-supplied CLI arguments", () => {
  const ids = spawningConnectors();

  test("are swept in every connector that spawns a CLI", () => {
    expect(ids).toEqual(EXPECTED_SPAWNING);
  });

  for (const id of ids) {
    test(`${id}: no tool hands its CLI an unchecked value`, async () => {
      resetConnectorModeForTests();
      setConnectorMode("gateway");
      try {
        const tools = captureTools(await registrarOf(id));
        const violations: string[] = [];
        const allowedUsed = new Set<(typeof ALLOWED)[number]>();
        for (const name of tools.names()) {
          const args = sweepArgs(name, tools.get(name).schema as ParsableSchema);
          const baseline = await run(tools, name, args);
          if (baseline.refused || baseline.argv.length === 0) {
            violations.push(`${name}: ordinary arguments did not reach a CLI`);
            continue;
          }
          for (const [field, value] of Object.entries(args)) {
            if (typeof value === "string") {
              const clis = clisCarrying(baseline.argv, value);
              violations.push(
                ...(await fieldViolations(tools, name, args, field, clis, allowedUsed)),
              );
            }
          }
        }
        for (const allowed of ALLOWED) {
          if (tools.names().includes(allowed.tool) && !allowedUsed.has(allowed)) {
            violations.push(
              `stale allowance: ${allowed.tool}.${allowed.field} no longer reaches argv`,
            );
          }
        }
        expect(violations).toEqual([]);
      } finally {
        resetConnectorModeForTests();
      }
    });
  }
});

/**
 * The discovery above, on files written for it: every real CLI connector imports the chokepoint or
 * `run-cli-json.ts` directly, so only here is the indirect case shown at all.
 */
describe("importsReach", () => {
  function tree(files: Record<string, string>): { at: (name: string) => string; done: () => void } {
    const dir = mkdtempSync(join(tmpdir(), "nimbus-imports-reach-"));
    for (const [name, content] of Object.entries(files)) {
      writeFileSync(join(dir, name), content);
    }
    return {
      at: (name) => join(dir, name),
      done: () => rmSync(dir, { recursive: true, force: true }),
    };
  }

  test("follows a chain through a helper, in every import form", () => {
    const t = tree({
      "target.ts": "export const spawnIt = 1;",
      "helper.ts": 'export { spawnIt } from "./target.ts";',
      "chain.ts": 'import { spawnIt } from "./helper.ts"; export const x = spawnIt;',
      "dynamic.ts": 'export const load = () => import("./helper.ts");',
      "required.ts": 'const h = require("./helper.ts"); export const y = h;',
      "extensionless.ts": 'import { spawnIt } from "./helper"; export const z = spawnIt;',
      "shebang.ts": '#!/usr/bin/env bun\nimport "./chain.ts";',
    });
    try {
      for (const file of [
        "chain.ts",
        "dynamic.ts",
        "required.ts",
        "extensionless.ts",
        "shebang.ts",
      ]) {
        expect({ file, reaches: importsReach(t.at(file), t.at("target.ts")) }).toEqual({
          file,
          reaches: true,
        });
      }
    } finally {
      t.done();
    }
  });

  test("does not reach through a type-only import, a package, or a cycle that never gets there", () => {
    const t = tree({
      "target.ts": "export type Spawn = () => void;",
      "typed.ts": 'import type { Spawn } from "./target.ts"; export type S = Spawn;',
      "package.ts": 'import { spawn } from "node:child_process"; export const s = spawn;',
      "a.ts": 'import "./b.ts";',
      "b.ts": 'import "./a.ts";',
    });
    try {
      for (const file of ["typed.ts", "package.ts", "a.ts"]) {
        expect({ file, reaches: importsReach(t.at(file), t.at("target.ts")) }).toEqual({
          file,
          reaches: false,
        });
      }
    } finally {
      t.done();
    }
  });

  test("fails, rather than ending the search, on an import that names no file", () => {
    const t = tree({ "broken.ts": 'import "./missing.ts";' });
    try {
      expect(() => importsReach(t.at("broken.ts"), t.at("target.ts"))).toThrow(
        "imports ./missing.ts, which names no file",
      );
    } finally {
      t.done();
    }
  });
});
