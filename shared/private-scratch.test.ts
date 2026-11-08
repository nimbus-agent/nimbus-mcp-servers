import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { resetConnectorModeForTests, setConnectorMode } from "./connector-mode.ts";
import {
  configuredScratchBase,
  SCRATCH_DIR_ENV,
  scratchDirBase,
  withScratchDir,
} from "./private-scratch.ts";

const roots: string[] = [];
let saved: string | undefined;

beforeEach(() => {
  saved = process.env[SCRATCH_DIR_ENV];
  delete process.env[SCRATCH_DIR_ENV];
  resetConnectorModeForTests();
});

afterEach(() => {
  if (saved === undefined) delete process.env[SCRATCH_DIR_ENV];
  else process.env[SCRATCH_DIR_ENV] = saved;
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
  resetConnectorModeForTests();
});

function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "nimbus-scratch-test-"));
  roots.push(d);
  return d;
}

describe("withScratchDir", () => {
  test("hands the body a fresh directory under the configured base, removed on success", async () => {
    const base = tempDir();
    process.env[SCRATCH_DIR_ENV] = base;
    let seen = "";
    const result = await withScratchDir("nimbus-t-", async (dir) => {
      seen = dir;
      expect(dirname(dir)).toBe(base);
      expect(dir.startsWith(join(base, "nimbus-t-"))).toBe(true);
      writeFileSync(join(dir, "f"), "x");
      return 42;
    });
    expect(result).toBe(42);
    expect(existsSync(seen)).toBe(false);
  });

  test("removes the directory when the body throws, and rethrows", async () => {
    const base = tempDir();
    process.env[SCRATCH_DIR_ENV] = base;
    let seen = "";
    await expect(
      withScratchDir("nimbus-t-", async (dir) => {
        seen = dir;
        writeFileSync(join(dir, "f"), "x");
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(existsSync(seen)).toBe(false);
  });

  test("gives concurrent calls separate directories", async () => {
    const base = tempDir();
    process.env[SCRATCH_DIR_ENV] = base;
    const dirs = await Promise.all([
      withScratchDir("nimbus-t-", async (d) => d),
      withScratchDir("nimbus-t-", async (d) => d),
    ]);
    expect(dirs[0]).not.toBe(dirs[1]);
  });

  test.skipIf(process.platform === "win32")("makes the directory private (0700)", async () => {
    process.env[SCRATCH_DIR_ENV] = tempDir();
    await withScratchDir("nimbus-t-", async (d) => {
      expect(statSync(d).mode & 0o777).toBe(0o700);
    });
  });

  test("falls back to the OS temp directory when the env var is unset (standalone)", async () => {
    setConnectorMode("standalone");
    await withScratchDir("nimbus-t-", async (d) => {
      expect(dirname(d)).toBe(tmpdir());
    });
  });
});

describe("scratch base", () => {
  test("refuses a relative env value", () => {
    process.env[SCRATCH_DIR_ENV] = "relative/scratch";
    expect(() => configuredScratchBase()).toThrow("must be an absolute path");
    expect(() => scratchDirBase()).toThrow("must be an absolute path");
  });

  test("treats a blank env value as unset", () => {
    process.env[SCRATCH_DIR_ENV] = "  ";
    expect(configuredScratchBase()).toBeUndefined();
  });

  test("win32 under the gateway with no env throws instead of using the user temp dir", () => {
    setConnectorMode("gateway");
    expect(() => scratchDirBase("win32")).toThrow(`${SCRATCH_DIR_ENV} is not set`);
  });

  test("win32 standalone falls back to the temp dir", () => {
    setConnectorMode("standalone");
    expect(scratchDirBase("win32")).toBe(tmpdir());
  });

  test("win32 under the gateway uses the env value when set", () => {
    setConnectorMode("gateway");
    const base = tempDir();
    process.env[SCRATCH_DIR_ENV] = base;
    expect(scratchDirBase("win32")).toBe(base);
  });

  test("linux under the gateway falls back to the temp dir", () => {
    setConnectorMode("gateway");
    expect(scratchDirBase("linux")).toBe(tmpdir());
  });
});
