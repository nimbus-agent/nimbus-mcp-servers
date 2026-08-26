import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { connectorDirs } from "./check-connector-consent.ts";

const ROOT = join(fileURLToPath(import.meta.url), "..", "..");
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
  exports: Record<string, string>;
  files: string[];
};

/**
 * Specifiers a CONSUMER imports that are not connector entrypoints.
 *
 * `shared/connector-mode.ts` is imported by the Nimbus gateway's `run-bundled-connector.ts`, which
 * calls `setConnectorMode` when it hosts a connector in-process. Version 0.1.0 SHIPPED that file —
 * `shared/**` is in `files` — but omitted it from `exports`, and an exports map is a whitelist: a
 * file present on disk but absent from the map is unreachable. Nothing caught it, because the
 * gateway still resolved the file by relative path from the monorepo copy that had not yet been
 * deleted. It would have surfaced as a broken build the moment that copy was removed.
 */
const CONSUMER_SPECIFIERS = ["./shared/connector-mode.ts"];

describe("exports map", () => {
  test("exposes every connector", () => {
    const missing = connectorDirs(ROOT).filter((id) => pkg.exports[`./${id}`] === undefined);
    expect(missing).toEqual([]);
  });

  test("every exports target exists on disk", () => {
    const broken = Object.entries(pkg.exports)
      .filter(([, target]) => !existsSync(join(ROOT, target)))
      .map(([key, target]) => `${key} -> ${target}`);
    expect(broken).toEqual([]);
  });

  test("exposes the non-connector specifiers consumers import", () => {
    const missing = CONSUMER_SPECIFIERS.filter((s) => pkg.exports[s] === undefined);
    expect(missing).toEqual([]);
  });

  // An exports entry that `files` does not ship resolves in this repo and 404s for everyone else —
  // the inverse of the 0.1.0 bug and just as invisible from inside a checkout.
  test("every exports target is actually packed", () => {
    const out = Bun.spawnSync(["npm", "pack", "--dry-run"], { cwd: ROOT, stderr: "pipe" });
    const text = new TextDecoder().decode(out.stderr) + new TextDecoder().decode(out.stdout);
    const packed = new Set(
      text
        .split("\n")
        .map((l) => l.replace(/^npm notice /, "").trim())
        .filter((l) => /^[\d.]+\s*[kMG]?B\s+\S/.test(l))
        .map((l) => l.split(/\s+/).slice(1).join(" ")),
    );
    const unpacked = Object.entries(pkg.exports)
      .map(([key, target]) => [key, target.replace(/^\.\//, "")] as const)
      .filter(([, target]) => !packed.has(target))
      .map(([key, target]) => `${key} -> ${target}`);
    expect(unpacked).toEqual([]);
  });
});
