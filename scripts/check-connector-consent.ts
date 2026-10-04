#!/usr/bin/env bun
import { type Dirent, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
// The launcher's own line scan, not a twin of it, so the two cannot disagree about what a
// registration line looks like. Which FILES they scan still differs: this audit reads every source
// file of a connector, the launcher only its server.ts and tools.ts.
import { registersWriteTool } from "../standalone/src/launcher.ts";

export type ConsentViolation = {
  readonly rule: "mode-setter-confined" | "mutation-declared";
  readonly file: string;
  readonly reason: string;
};

/**
 * The only production files permitted to name the mode setter.
 *
 * "The mode comes from the entrypoint" is a convention until something enforces it. Any other
 * caller could re-gate a connector mid-process, which is exactly what Non-Negotiable #2 forbids.
 * Test files are exempt: they are in-repo code, not a runtime switch.
 */
const MODE_SETTER_ALLOWED = new Set(["shared/connector-mode.ts"]);

/**
 * Rule 2 is now BLOCKING, and it keys on the MANIFEST alone.
 *
 * The HTTP-verb signal it used to carry was removed, on evidence. Once every connector was
 * migrated it still produced 32 findings and essentially all were false: `search-filter.ts` files
 * that do pure filtering, transport helpers like `imap-core.ts`, the seven read-only connectors
 * that POST for GraphQL/search/auth, `kb-append.ts` whose tool is registered in `server.ts`, and
 * the standalone launcher's own `bin.ts`. The rule was per-FILE while migration is per-CONNECTOR,
 * so a helper holding a verb literal never contains the registration.
 *
 * `hitlRequired` is the authoritative signal: authored per connector, transport independent, and
 * true for the ten that mutate through a CLI, the filesystem or a mail protocol with no HTTP
 * request to inspect. A connector that mutates without declaring it is a connector bug — caught in
 * review, not by a heuristic that provably cannot tell.
 */
export const MUTATION_RULE_BLOCKING = true;

/**
 * Whether the connector owning `rel` declares `write` or `delete` in `hitlRequired`.
 *
 * The manifest is the reliable mutation signal for the ten connectors that mutate through a CLI,
 * the filesystem or a mail protocol, where no verb appears in source — and it is the ONLY signal
 * this audit reads. The HTTP-verb pattern once checked beside it is gone; see
 * {@link MUTATION_RULE_BLOCKING} for why.
 */
function connectorDeclaresWrite(root: string, rel: string): boolean {
  const name = rel.split("/")[1];
  if (name === undefined || name === "") return false;
  try {
    const manifest: unknown = JSON.parse(
      readFileSync(join(root, CONNECTORS_SUBDIR, name, "nimbus.extension.json"), "utf8"),
    );
    if (typeof manifest !== "object" || manifest === null) return false;
    const hitl = (manifest as Record<string, unknown>)["hitlRequired"];
    return Array.isArray(hitl) && hitl.some((h) => h === "write" || h === "delete");
  } catch {
    // An unreadable manifest is an OBSERVATION failure. Fail SAFE: treat it as declaring a write,
    // so the cost is a false positive on one connector rather than silently certifying a mutating
    // one as needing no declaration.
    return true;
  }
}

/**
 * Drop comment-only lines.
 *
 * Deliberately NOT `stripComments` from ./lib.ts. That helper has no regex-literal awareness: a
 * regex containing a quote character — `/(["'`])(POST|PUT)\1/`, which both this audit and the
 * standalone launcher carry — opens a phantom string, and every comment after it survives intact.
 * Verified: a file whose first line is such a regex has its later JSDoc left completely unstripped.
 *
 * A line-based skip is cruder but correct for what this audit asks. It matters because the launcher
 * documents that it deliberately does NOT call setConnectorMode, and a naive match flagged that
 * explanation as a violation — a guard that punishes writing down WHY is worse than useless.
 */
function codeOnly(src: string): string {
  return src
    .split("\n")
    .filter((line) => {
      const t = line.trim();
      return !(t.startsWith("*") || t.startsWith("//") || t.startsWith("/*"));
    })
    .join("\n");
}

/** `connectors/<name>/src/...` → `<name>`. */
function connectorOf(rel: string): string {
  return rel.split("/")[1] ?? "";
}

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name !== "node_modules" && e.name !== "dist") walk(p, out);
    } else if (e.name.endsWith(".ts")) {
      out.push(p);
    }
  }
  return out;
}

/**
 * Every directory that IS a connector: one holding `src/server.ts`.
 *
 * Positive identification, not a blocklist. The monorepo copy of this audit skipped `shared`,
 * `standalone` and `node_modules` by name, and the `node_modules` entry had to be ADDED after the
 * connector tree became a package in its own right and the audit read a dependency directory as a
 * connector — finding no manifest, failing safe, and reporting a fabricated ungated-write. In this
 * repo the connectors sit at the ROOT alongside `scripts`, `.github` and anything a future
 * contributor adds, so a blocklist would need extending for each one and would fail the same way
 * every time it was not. Asking what a connector HAS cannot fail that way.
 */
export const CONNECTORS_SUBDIR = "connectors";

export function connectorDirs(root: string): string[] {
  const dir = join(root, CONNECTORS_SUBDIR);
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    // A tree with no connectors/ directory yields no connectors, rather than throwing. The
    // audit's own fixtures build partial trees, and a missing directory is not a violation.
    return [];
  }
  return entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .filter((name) => {
      try {
        return statSync(join(dir, name, "src", "server.ts")).isFile();
      } catch {
        return false;
      }
    })
    .sort((a, b) => a.localeCompare(b));
}

/** One readable source file: its repo-relative path (forward slashes) and comment-stripped body. */
type Source = { readonly rel: string; readonly src: string };

/**
 * Every non-test `.ts` file under the given bases.
 *
 * Forward slashes so the allow-list comparison is identical on Windows. A base that is missing or
 * is not a directory contributes nothing rather than throwing — the audit's own fixtures build
 * partial trees.
 */
function readSources(root: string, bases: readonly string[]): Source[] {
  const out: Source[] = [];
  for (const base of bases) {
    const dir = join(root, base);
    try {
      if (!statSync(dir).isDirectory()) continue;
    } catch {
      continue;
    }
    for (const file of walk(dir)) {
      const rel = relative(root, file).replaceAll("\\", "/");
      if (rel.endsWith(".test.ts")) continue;
      out.push({ rel, src: codeOnly(readFileSync(file, "utf8")) });
    }
  }
  return out;
}

/** The mode-setter finding for one file, if it has one. */
function modeSetterViolation({ rel, src }: Source): ConsentViolation | undefined {
  if (!src.includes("setConnectorMode(") || MODE_SETTER_ALLOWED.has(rel)) return undefined;
  return {
    rule: "mode-setter-confined",
    file: rel,
    reason:
      "names setConnectorMode outside its sanctioned callers — the mode must come from the " +
      "entrypoint, not from arbitrary code",
  };
}

/**
 * Connectors that declare a mutating tool without registering one through the consent kit.
 *
 * Per CONNECTOR, not per file: a connector's write registration lives in one of its files and its
 * verb literals may live in another.
 */
function undeclaredWriteViolations(
  root: string,
  names: readonly string[],
  hardened: ReadonlySet<string>,
): ConsentViolation[] {
  return names
    .filter((name) => connectorDeclaresWrite(root, `${CONNECTORS_SUBDIR}/${name}/src/server.ts`))
    .filter((name) => !hardened.has(name))
    .map((name) => ({
      rule: "mutation-declared" as const,
      file: `${CONNECTORS_SUBDIR}/${name}/nimbus.extension.json`,
      reason:
        "declares write or delete in hitlRequired but no file in the connector registers a write " +
        "tool through the consent kit — running it standalone would expose ungated mutations. " +
        "Route its mutating tools through registerWriteTool, or correct the manifest if it does " +
        "not actually mutate",
    }));
}

/**
 * Split into readSources / modeSetterViolation / undeclaredWriteViolations because this function
 * was doing all three at once, at a cognitive complexity of 22 against the 15 allowed. The pieces
 * are also the units worth testing separately: "which files does it read" and "what counts as a
 * violation" are different questions.
 */
export function checkConnectorConsent(
  root: string = resolve(import.meta.dir, ".."),
): ConsentViolation[] {
  const names = connectorDirs(root);
  const bases = [...names.map((n) => join(CONNECTORS_SUBDIR, n)), "shared", "standalone"];
  const out: ConsentViolation[] = [];
  const hardened = new Set<string>();

  for (const source of readSources(root, bases)) {
    const violation = modeSetterViolation(source);
    if (violation !== undefined) out.push(violation);
    // A CALL, not the declaration. `const registerWriteTool = createWriteToolRegistrar(...)`
    // contains the identifier too, so a substring check called a connector hardened even after
    // every one of its write registrations had been reverted — caught by red-proving this gate.
    if (registersWriteTool(source.src)) hardened.add(connectorOf(source.rel));
  }

  out.push(...undeclaredWriteViolations(root, names, hardened));
  return out;
}

/**
 * Print the verdict and return the process exit code. A `mutation-declared` finding blocks only
 * while `mutationBlocking` (default {@link MUTATION_RULE_BLOCKING}) holds; otherwise it is printed
 * as a warning and counted as advisory.
 *
 * Split out of the `import.meta.main` block so it can be tested — that guard is false under an
 * import, so anything inside it is unreachable to every in-process test (the reason
 * `check-connector-deps.ts` has `report()`).
 */
export function report(
  violations: readonly ConsentViolation[],
  mutationBlocking: boolean = MUTATION_RULE_BLOCKING,
): number {
  const blocking = violations.filter((v) => v.rule !== "mutation-declared" || mutationBlocking);
  for (const v of violations) {
    const level = blocking.includes(v) ? "error" : "warning";
    console.error(`::${level} file=${v.file}::${v.reason}`);
  }
  const advisory = violations.length - blocking.length;
  console.log(
    blocking.length === 0
      ? `connector consent: ok (${String(advisory)} advisory)`
      : `connector consent: ${String(blocking.length)} violation(s)`,
  );
  return blocking.length > 0 ? 1 : 0;
}

if (import.meta.main) {
  process.exit(report(checkConnectorConsent()));
}
