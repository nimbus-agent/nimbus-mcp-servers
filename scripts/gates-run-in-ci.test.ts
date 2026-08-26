import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(import.meta.url), "..", "..");
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
  scripts: Record<string, string>;
};
const workflow = readFileSync(join(ROOT, ".github", "workflows", "ci.yml"), "utf8");

/**
 * A gate that exists but runs nowhere is worse than no gate: the PR goes green and the green is
 * meaningless. The Nimbus monorepo shipped exactly that — `audit:connector-consent` was added to
 * its script manifest and to no workflow, so it executed in no CI job, and the PR that introduced
 * it passed BECAUSE the gate never ran.
 */
describe("every gate runs in CI", () => {
  const gates = Object.keys(pkg.scripts).filter((k) => k.startsWith("audit:"));

  test("there is at least one gate to check", () => {
    expect(gates.length).toBeGreaterThan(0);
  });

  test("each audit script is invoked by the CI workflow", () => {
    const missing = gates.filter((g) => !workflow.includes(`bun run ${g}`));
    expect(missing).toEqual([]);
  });

  test("each audit script is also part of `bun run check`", () => {
    const check = pkg.scripts["check"] ?? "";
    const missing = gates.filter((g) => !check.includes(`bun run ${g}`));
    expect(missing).toEqual([]);
  });
});
