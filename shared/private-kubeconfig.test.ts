import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  SCRATCH_DIR_ENV,
  singleKubeconfigPath,
  withPrivateKubeconfig,
} from "./private-kubeconfig.ts";

const roots: string[] = [];
let savedScratch: string | undefined;

beforeEach(() => {
  savedScratch = process.env[SCRATCH_DIR_ENV];
  delete process.env[SCRATCH_DIR_ENV];
});

afterEach(() => {
  if (savedScratch === undefined) delete process.env[SCRATCH_DIR_ENV];
  else process.env[SCRATCH_DIR_ENV] = savedScratch;
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "kubecfg-test-"));
  roots.push(d);
  return d;
}

function sourceFile(content = "apiVersion: v1\nkind: Config\n"): string {
  const p = join(tempDir(), "kubeconfig");
  writeFileSync(p, content);
  return p;
}

describe("singleKubeconfigPath", () => {
  test("a path with no separator is one path", () => {
    expect(singleKubeconfigPath("/home/me/.kube/config", ":")).toBe("/home/me/.kube/config");
  });

  test("a colon list is refused where the delimiter is a colon", () => {
    expect(() => singleKubeconfigPath("/a/config:/b/config", ":")).toThrow(/more than one file/);
  });

  test("a Windows drive path is ONE path where the delimiter is a semicolon", () => {
    expect(singleKubeconfigPath(String.raw`C:\Users\me\.kube\config`, ";")).toBe(
      String.raw`C:\Users\me\.kube\config`,
    );
  });

  test("a semicolon list is refused where the delimiter is a semicolon", () => {
    expect(() => singleKubeconfigPath(String.raw`C:\a\config;D:\b\config`, ";")).toThrow(
      /more than one file/,
    );
  });

  test("a drive path IS split where the delimiter is a colon (the delimiter decides, not the text)", () => {
    expect(() => singleKubeconfigPath(String.raw`C:\a\config`, ":")).toThrow(/more than one/);
    expect(() => singleKubeconfigPath("C:/a/config:D:/b/config", ":")).toThrow(/more than one/);
  });

  test("the default separator is the platform's", () => {
    const other = process.platform === "win32" ? ":" : ";";
    // The OTHER platform's separator is an ordinary character here.
    expect(singleKubeconfigPath(`/a${other}b`)).toBe(`/a${other}b`);
  });

  test("unset, empty and blank are refused with the one message the tools report", () => {
    for (const v of [undefined, "", "   "]) {
      expect(() => singleKubeconfigPath(v)).toThrow("KUBECONFIG env must be set");
    }
  });
});

describe("withPrivateKubeconfig", () => {
  test("hands the body a copy: another path, the same bytes, owner-only on POSIX", async () => {
    const src = sourceFile();
    let seen = "";
    await withPrivateKubeconfig({ source: src }, async (env) => {
      seen = env.KUBECONFIG;
      expect(env.KUBECONFIG).not.toBe(src);
      expect(readFileSync(env.KUBECONFIG, "utf8")).toBe("apiVersion: v1\nkind: Config\n");
      if (process.platform !== "win32") {
        expect(statSync(env.KUBECONFIG).mode & 0o777).toBe(0o600);
      }
    });
    expect(existsSync(seen)).toBe(false);
  });

  test("removes the copy when the body throws, and rethrows the body's error", async () => {
    let seen = "";
    await expect(
      withPrivateKubeconfig({ source: sourceFile() }, async (env) => {
        seen = env.KUBECONFIG;
        throw new Error("kubectl failed");
      }),
    ).rejects.toThrow("kubectl failed");
    expect(seen).not.toBe("");
    expect(existsSync(seen)).toBe(false);
  });

  test("two concurrent calls never share a file", async () => {
    const src = sourceFile();
    const paths: string[] = [];
    const run = (): Promise<void> =>
      withPrivateKubeconfig({ source: src }, async (env) => {
        paths.push(env.KUBECONFIG);
        await new Promise((r) => setTimeout(r, 20));
        // Still there while the other call is in flight.
        expect(existsSync(env.KUBECONFIG)).toBe(true);
      });
    await Promise.all([run(), run()]);
    expect(new Set(paths).size).toBe(2);
  });

  test("writes the body does to its copy never reach the source (bytes and mtime unchanged)", async () => {
    const src = sourceFile();
    const old = new Date("2020-01-01T00:00:00Z");
    utimesSync(src, old, old);
    await withPrivateKubeconfig({ source: src }, async (env) => {
      writeFileSync(env.KUBECONFIG, "overwritten by get-credentials");
    });
    expect(readFileSync(src, "utf8")).toBe("apiVersion: v1\nkind: Config\n");
    expect(statSync(src).mtime.getTime()).toBe(old.getTime());
  });

  test("without a source the copy starts empty, for get-credentials to fill", async () => {
    let seen = "";
    await withPrivateKubeconfig({}, async (env) => {
      seen = env.KUBECONFIG;
      expect(readFileSync(env.KUBECONFIG, "utf8")).toBe("");
    });
    expect(existsSync(seen)).toBe(false);
  });

  test("honours NIMBUS_CONNECTOR_SCRATCH_DIR", async () => {
    const scratch = tempDir();
    process.env[SCRATCH_DIR_ENV] = scratch;
    await withPrivateKubeconfig({}, async (env) => {
      expect(env.KUBECONFIG.startsWith(scratch)).toBe(true);
    });
  });

  test("refuses a relative NIMBUS_CONNECTOR_SCRATCH_DIR, before reading anything", async () => {
    process.env[SCRATCH_DIR_ENV] = "relative/dir";
    let ran = false;
    await expect(
      withPrivateKubeconfig({}, async () => {
        ran = true;
      }),
    ).rejects.toThrow(/absolute/);
    expect(ran).toBe(false);
  });

  test("refuses a source that is a directory or does not exist, without running the body", async () => {
    let ran = false;
    const body = async (): Promise<void> => {
      ran = true;
    };
    await expect(withPrivateKubeconfig({ source: tempDir() }, body)).rejects.toThrow(
      /regular file/,
    );
    await expect(
      withPrivateKubeconfig({ source: join(tempDir(), "missing") }, body),
    ).rejects.toThrow(/does not exist/);
    expect(ran).toBe(false);
  });

  test("refuses a source that is a symlink when the platform lets the test make one", async () => {
    const src = sourceFile();
    const link = join(tempDir(), "link");
    try {
      symlinkSync(src, link);
    } catch {
      // Windows without the symlink privilege: nothing to assert here.
      return;
    }
    await expect(withPrivateKubeconfig({ source: link }, async () => undefined)).rejects.toThrow(
      /regular file/,
    );
  });

  test("a source naming a list is refused with no directory made", async () => {
    const scratch = tempDir();
    process.env[SCRATCH_DIR_ENV] = scratch;
    mkdirSync(join(scratch, "keep"));
    const list = ["/a/config", "/b/config"].join(process.platform === "win32" ? ";" : ":");
    await expect(withPrivateKubeconfig({ source: list }, async () => undefined)).rejects.toThrow(
      /more than one file/,
    );
    expect(existsSync(join(scratch, "keep"))).toBe(true);
    expect(existsSync(scratch) && statSync(scratch).isDirectory()).toBe(true);
  });
});
