import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { byExtension, walkFiles } from "./walk-files.ts";

/** A directory tree from a map of relative path → contents. */
function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "walk-"));
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(root, ...rel.split("/"));
    mkdirSync(abs.slice(0, abs.lastIndexOf(sep)), { recursive: true });
    writeFileSync(abs, body, "utf8");
  }
  return root;
}

// The trees are left in the OS temp dir: they are a few empty files each, and a
// recursive delete would have to reason about the symlink one test creates.

const all = { maxFiles: 1000, maxDepth: 12 };

describe("walkFiles", () => {
  it("finds files at every depth within the limit", async () => {
    const root = tree({ "a.json": "{}", "one/b.json": "{}", "one/two/c.json": "{}" });
    const found = await walkFiles(root, { ...all, select: byExtension(".json") });
    expect(found).toHaveLength(3);
  });

  it("returns [] rather than throwing when the root cannot be read", async () => {
    // The same catch that makes a permission-denied SUBdirectory a skip rather
    // than a failed tool call — a scan of a user-configured tree meets those
    // routinely, and one must not cost the caller every other result.
    const found = await walkFiles(join(tmpdir(), "walk-does-not-exist-12345"), {
      ...all,
      select: byExtension(".json"),
    });
    expect(found).toEqual([]);
  });

  it("keeps the results found before an unreadable subdirectory", async () => {
    const root = tree({ "keep.json": "{}", "sub/inner.json": "{}" });
    // `sub` is replaced by a FILE, so `readdir` on it throws exactly as it does
    // for a directory the process may not read.
    writeFileSync(join(root, "sub-not-a-dir"), "x", "utf8");
    const found = await walkFiles(root, { ...all, select: byExtension(".json") });
    expect(found).toHaveLength(2);
  });

  it("stops descending past maxDepth", async () => {
    const root = tree({ "a.json": "{}", "one/b.json": "{}", "one/two/c.json": "{}" });
    const depth0 = await walkFiles(root, { ...all, maxDepth: 0, select: byExtension(".json") });
    expect(depth0.map((p) => p.endsWith("a.json"))).toEqual([true]);

    const depth1 = await walkFiles(root, { ...all, maxDepth: 1, select: byExtension(".json") });
    expect(depth1).toHaveLength(2);
  });

  it("stops at maxFiles", async () => {
    const root = tree(
      Object.fromEntries([...Array(10).keys()].map((i) => [`f${String(i)}.json`, "{}"])),
    );
    expect(
      await walkFiles(root, { ...all, maxFiles: 4, select: byExtension(".json") }),
    ).toHaveLength(4);
  });

  it("stops at maxFiles across nested directories too", async () => {
    const root = tree({
      "a.json": "{}",
      "one/b.json": "{}",
      "one/c.json": "{}",
      "one/two/d.json": "{}",
    });
    expect(
      await walkFiles(root, { ...all, maxFiles: 2, select: byExtension(".json") }),
    ).toHaveLength(2);
  });

  it("does not follow symlinked directories, so a cycle cannot diverge", async () => {
    const root = tree({ "a.json": "{}", "sub/b.json": "{}" });
    try {
      symlinkSync(root, join(root, "sub", "loop"), "dir");
    } catch {
      return; // symlink creation needs privileges on some Windows configs
    }
    expect(await walkFiles(root, { ...all, select: byExtension(".json") })).toHaveLength(2);
  });

  it("keeps only what `select` returns, and passes the full path", async () => {
    const root = tree({ "a.json": "{}", "b.sql": "SELECT 1", "c.txt": "x" });
    const found = await walkFiles(root, {
      ...all,
      select: (entry, full) =>
        entry.name.endsWith(".sql") ? { name: entry.name, full } : undefined,
    });
    expect(found).toHaveLength(1);
    expect(found[0]?.name).toBe("b.sql");
    expect(found[0]?.full.endsWith(`${sep}b.sql`)).toBe(true);
  });
});

describe("byExtension", () => {
  it("matches case-insensitively", async () => {
    const root = tree({ "A.JSON": "{}", "b.json": "{}" });
    expect(await walkFiles(root, { ...all, select: byExtension(".json") })).toHaveLength(2);
  });

  it("accepts several extensions", async () => {
    const root = tree({ "a.csv": "", "b.tsv": "", "c.txt": "" });
    expect(await walkFiles(root, { ...all, select: byExtension(".csv", ".tsv") })).toHaveLength(2);
  });

  it("keeps nothing when no extension matches", async () => {
    const root = tree({ "a.txt": "" });
    expect(await walkFiles(root, { ...all, select: byExtension(".json") })).toEqual([]);
  });
});
