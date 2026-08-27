import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(import.meta.url), "..", "..");
const read = (f: string): unknown => JSON.parse(readFileSync(join(ROOT, f), "utf8"));

const pkg = read("package.json") as { name: string; version: string };
const manifest = read(".release-please-manifest.json") as Record<string, string>;
const config = read("release-please-config.json") as {
  packages: Record<string, { "package-name"?: string; "release-type"?: string }>;
};
const workflow = readFileSync(join(ROOT, ".github", "workflows", "release.yml"), "utf8");

/**
 * The workflow with comment-only lines removed.
 *
 * Needed because the file DOCUMENTS the absence of a token — "No NODE_AUTH_TOKEN: the npm
 * trusted-publisher binding authenticates this workflow" — and a plain substring check on the raw
 * text fails on that sentence. A guard that punishes writing down WHY is worse than useless.
 */
const workflowCode = workflow
  .split("\n")
  .filter((line) => !line.trim().startsWith("#"))
  .join("\n");

/**
 * release-please owns the version. These assertions exist because the monorepo's copy of this
 * number was hand-maintained and sat wrong for TEN releases, across a major-version boundary,
 * with nothing to notice.
 */
describe("release configuration", () => {
  test("the manifest version matches package.json", () => {
    expect(manifest["."]).toBe(pkg.version);
  });

  test("the configured package name matches package.json", () => {
    expect(config.packages["."]?.["package-name"]).toBe(pkg.name);
  });

  // Publishing is token-less OIDC. A NODE_AUTH_TOKEN would silently take over and publish WITHOUT
  // provenance, which is not detectable after the fact from the workflow file alone.
  test("the publish job uses OIDC, not a token", () => {
    expect(workflow).toContain("id-token: write");
    expect(workflow).toContain("npm publish --provenance --access public");
    expect(workflowCode).not.toContain("NODE_AUTH_TOKEN");
  });

  test("the release workflow publishes the package this repo actually is", () => {
    expect(workflow).toContain(`package: "${pkg.name}"`);
    expect(workflow).toContain("expected-repo: nimbus-agent/nimbus-mcp-servers");
  });
});
