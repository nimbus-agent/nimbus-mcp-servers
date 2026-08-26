import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { connectorDirs } from "./check-connector-consent.ts";

const ROOT = join(fileURLToPath(import.meta.url), "..", "..");

/**
 * What `npm publish` would actually ship, asked of npm rather than reimplemented.
 *
 * `npm pack --dry-run` applies the real `files` semantics — negations, directory recursion and the
 * always-included set — which a hand-rolled glob walk would only approximate. The approximation is
 * the failure mode worth avoiding: a guard that disagrees with the packer certifies the wrong tree.
 */
function packedFiles(): string[] {
  const out = Bun.spawnSync(["npm", "pack", "--dry-run"], { cwd: ROOT, stderr: "pipe" });
  const text = new TextDecoder().decode(out.stderr) + new TextDecoder().decode(out.stdout);
  return text
    .split("\n")
    .map((l) => l.replace(/^npm notice /, "").trim())
    .filter((l) => /^[\d.]+\s*[kMG]?B\s+\S/.test(l))
    .map((l) => l.split(/\s+/).slice(1).join(" "))
    .filter((l) => l.length > 0);
}

describe("published tarball", () => {
  const files = packedFiles();

  test("ships no test files", () => {
    expect(files.filter((f) => /\.(test|spec)\.ts$/.test(f))).toEqual([]);
  });

  test("ships every connector's entrypoint and manifest", () => {
    const missing = connectorDirs(ROOT).flatMap((id) =>
      [`connectors/${id}/src/server.ts`, `connectors/${id}/nimbus.extension.json`].filter(
        (f) => !files.includes(f),
      ),
    );
    expect(missing).toEqual([]);
  });

  test("ships the launcher the bin field points at", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
      bin: Record<string, string>;
    };
    for (const target of Object.values(pkg.bin)) {
      expect(files).toContain(target.replace(/^\.\//, ""));
    }
  });

  test("ships shared/, which every connector imports by relative path", () => {
    expect(files.some((f) => f.startsWith("shared/"))).toBe(true);
  });

  // `standalone/package.json` declares a SECOND package identity (@nimbus-dev/mcp-connector) with
  // its own dependencies and a bin pointing at a dist/ that has never been built. Shipping any
  // nested manifest puts a package boundary inside this package; it is excluded deliberately.
  test("ships no nested package.json", () => {
    expect(files.filter((f) => f.endsWith("package.json") && f.includes("/"))).toEqual([]);
  });
});
