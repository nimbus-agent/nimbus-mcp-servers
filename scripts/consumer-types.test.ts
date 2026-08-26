import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(import.meta.url), "..", "..");
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
  dependencies: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  devDependencies: Record<string, string>;
};

/** Does the installed package carry its own type declarations? */
function shipsOwnTypes(name: string): boolean {
  const dir = join(ROOT, "node_modules", ...name.split("/"));
  if (!existsSync(dir)) return true; // Not installed here — not this test's business.
  try {
    const m = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as {
      types?: string;
      typings?: string;
    };
    if (typeof m.types === "string" || typeof m.typings === "string") return true;
  } catch {
    return true;
  }
  return existsSync(join(dir, "index.d.ts"));
}

/**
 * This package ships raw TypeScript, so its TYPE dependencies are consumer-facing.
 *
 * A consumer that typechecks through the exports map compiles these `.ts` sources directly —
 * `skipLibCheck` does not apply, because they are source, not declarations. So any `@types/*` the
 * shipped sources need must be a real `dependency`; as a `devDependency` it reaches nobody.
 *
 * This is not hypothetical. `@types/nodemailer` sat in devDependencies through 0.1.0 and 0.1.1, and
 * the Nimbus gateway's typecheck failed in CI with TS7016 on three connectors — while passing
 * locally, because a stale `@types/nodemailer` happened to be in that machine's install cache.
 */
describe("consumer-facing types", () => {
  const runtime = { ...pkg.dependencies, ...(pkg.optionalDependencies ?? {}) };

  test("every runtime dependency without its own types has @types in dependencies", () => {
    const missing = Object.keys(runtime)
      .filter((name) => !name.startsWith("@types/"))
      .filter((name) => !shipsOwnTypes(name))
      .map((name) => `@types/${name.replace("@", "").replace("/", "__")}`)
      .filter((types) => existsSync(join(ROOT, "node_modules", ...types.split("/"))))
      .filter((types) => pkg.dependencies[types] === undefined);
    expect(missing).toEqual([]);
  });

  test("no @types package needed by shipped sources hides in devDependencies", () => {
    const strays = Object.keys(pkg.devDependencies)
      .filter((n) => n.startsWith("@types/"))
      // @types/bun types the TEST and script code, which consumers never compile.
      .filter((n) => n !== "@types/bun");
    expect(strays).toEqual([]);
  });
});
