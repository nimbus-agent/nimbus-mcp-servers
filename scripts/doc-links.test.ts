import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(import.meta.url), "..", "..");

function markdownFiles(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === ".git" || e.name === "dist") continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) markdownFiles(p, out);
    else if (e.name.endsWith(".md")) out.push(p);
  }
  return out;
}

/** Relative markdown links only — an external URL is not this test's business. */
const LINK_RE = /\[[^\]]*\]\((\.{1,2}\/[^)\s#]*)/g;

describe("documentation links", () => {
  // The connectors moved from the repo root to connectors/<id>/, which changed the depth of every
  // relative link that escapes a connector directory. One survived the move pointing a level too
  // high — it resolved to a path OUTSIDE the repository, where nothing would ever report it.
  test("every relative link resolves to a file in the repo", () => {
    const broken: string[] = [];
    for (const file of markdownFiles(ROOT)) {
      const dir = join(file, "..");
      for (const m of readFileSync(file, "utf8").matchAll(LINK_RE)) {
        const target = m[1];
        if (target === undefined || target === "") continue;
        const resolved = normalize(join(dir, target));
        if (!existsSync(resolved)) {
          broken.push(`${file.slice(ROOT.length + 1)} -> ${target}`);
        }
      }
    }
    expect(broken).toEqual([]);
  });

  test("the repo root holds exactly one README", () => {
    const roots = readdirSync(ROOT, { withFileTypes: true })
      .filter((e) => e.isFile() && /^readme\.md$/i.test(e.name))
      .map((e) => e.name);
    expect(roots).toEqual(["README.md"]);
  });
});
