#!/usr/bin/env bun
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

export const REPO_ROOT = resolve(import.meta.dir, "..");
export const CONNECTORS_DIR = join(REPO_ROOT, "connectors");

/**
 * Runtime dependencies a first-party connector may declare. Every connector is bundled into the
 * gateway binary, so a native (node-gyp / prebuilt `.node`) dependency would either fail the
 * compile or produce a binary that cannot load its shared library at runtime — and the only symptom
 * a user sees is a sync that never works. Keep this list pure JavaScript.
 */
export const ALLOWED_CONNECTOR_DEPS: readonly string[] = [
  "@modelcontextprotocol/sdk",
  "@nimbus-dev/sdk",
  "zod",
  "hyparquet",
  "imapflow",
  "nodemailer",
  "tsdav",
];

/**
 * `@types/*` packages carry declarations and no runtime code, by construction.
 *
 * This gate exists because a NATIVE dependency breaks the compiled gateway binary silently — a
 * risk a types-only package cannot pose: nothing of it survives compilation. Exempted as a class
 * rather than listed one by one, so adding a needed `@types/*` never requires editing the
 * allow-list for a reason that does not apply to it.
 *
 * They are not unguarded. `consumer-types.test.ts` asserts that any `@types/*` the SHIPPED sources
 * need is a real dependency rather than a devDependency — this package ships raw TypeScript, so a
 * consumer compiles those sources and needs the same declarations.
 */
function isTypesOnly(dep: string): boolean {
  return dep.startsWith("@types/");
}

export interface DepViolation {
  readonly connector: string;
  readonly dependency: string;
}

/**
 * Every manifest field that can put a package into a connector's runtime graph. Checking only
 * `dependencies` would let a native module in via `optionalDependencies` or `peerDependencies`.
 */
const RUNTIME_DEP_FIELDS = ["dependencies", "optionalDependencies", "peerDependencies"] as const;

/** Read the runtime dependency names out of unvalidated external JSON. */
function runtimeDepNames(parsed: unknown): string[] {
  if (typeof parsed !== "object" || parsed === null) return [];
  const record = parsed as Record<string, unknown>;
  const names: string[] = [];
  for (const field of RUNTIME_DEP_FIELDS) {
    const value = record[field];
    if (typeof value !== "object" || value === null) continue;
    names.push(...Object.keys(value as Record<string, unknown>));
  }
  return names;
}

/** Read and parse a manifest, treating an unreadable one as an OBSERVATION failure. */
function readManifest(pkgPath: string): unknown {
  try {
    return JSON.parse(readFileSync(pkgPath, "utf8"));
  } catch (e) {
    throw new Error(
      `check-connector-deps: cannot read ${pkgPath}: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

/**
 * `dir` is the connectors directory; `root` is the repository root.
 *
 * The ROOT manifest is checked too, and it is the one that matters most here. When the connectors
 * lived in the monorepo each had its own installed dependencies, so a per-connector manifest WAS
 * the runtime graph. In this repository they ship as one package: the per-connector manifests are
 * metadata and nothing installs from them, while the root `dependencies` and `optionalDependencies`
 * are what a consumer — including the Nimbus gateway, which bundles this package into a compiled
 * binary — actually resolves. Checking only the per-connector files would leave the real graph
 * unguarded, which is the inverse of the bug this audit exists to prevent.
 */
export function checkConnectorDeps(
  dir: string = CONNECTORS_DIR,
  root: string = REPO_ROOT,
): DepViolation[] {
  const allowed = new Set(ALLOWED_CONNECTOR_DEPS);
  const out: DepViolation[] = [];
  const rootPkg = join(root, "package.json");
  if (existsSync(rootPkg)) {
    for (const dep of runtimeDepNames(readManifest(rootPkg))) {
      if (isTypesOnly(dep) || allowed.has(dep)) continue;
      out.push({ connector: "<root>", dependency: dep });
    }
  }
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const pkgPath = join(dir, entry.name, "package.json");
    if (!existsSync(pkgPath)) continue;
    // An unreadable or malformed manifest is an OBSERVATION failure, not a dependency violation —
    // reporting it as a violation would name an innocent package. Fail loudly instead.
    for (const dep of runtimeDepNames(readManifest(pkgPath))) {
      if (isTypesOnly(dep) || allowed.has(dep)) continue;
      out.push({ connector: entry.name, dependency: dep });
    }
  }
  return out;
}

if (import.meta.main) {
  const violations = checkConnectorDeps();
  for (const v of violations) {
    console.error(
      `::error file=${v.connector === "<root>" ? "package.json" : `connectors/${v.connector}/package.json`}::dependency "${v.dependency}" is not in ALLOWED_CONNECTOR_DEPS — connectors are bundled into the gateway binary, so a native dependency breaks it silently`,
    );
  }
  console.log(
    violations.length === 0
      ? "connector deps: ok"
      : `connector deps: ${violations.length} violation(s)`,
  );
  process.exit(violations.length > 0 ? 1 : 0);
}
