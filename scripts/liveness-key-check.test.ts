import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkLivenessKey } from "./liveness-key-check.ts";

const SCRIPT = join(fileURLToPath(import.meta.url), "..", "liveness-key-check.ts");
const KEY = `${"A".repeat(43)}=`;
const OTHER = `${"B".repeat(43)}=`;

describe("checkLivenessKey", () => {
  test("an absent livenessKey needs the key", () => {
    expect(checkLivenessKey(JSON.stringify({ sequence: 1 }), KEY)).toEqual({ needed: true });
  });
  test("the same key is already set", () => {
    expect(checkLivenessKey(JSON.stringify({ livenessKey: KEY }), KEY)).toEqual({ needed: false });
  });
  test("a different key is needed", () => {
    expect(checkLivenessKey(JSON.stringify({ livenessKey: OTHER }), KEY)).toEqual({ needed: true });
  });
  test("an empty key throws rather than reading as already set", () => {
    expect(() => checkLivenessKey(JSON.stringify({ sequence: 1 }), "")).toThrow(
      /NIMBUS_REGISTRY_LIVENESS_PUBLIC_KEY/,
    );
  });
  test.each([["abc"], ["A".repeat(43)], [`${"A".repeat(42)} =`]])("rejects %p", (bad) => {
    expect(() => checkLivenessKey("{}", bad)).toThrow(/NIMBUS_REGISTRY_LIVENESS_PUBLIC_KEY/);
  });
  test("a non-string livenessKey throws", () => {
    expect(() => checkLivenessKey(JSON.stringify({ livenessKey: 5 }), KEY)).toThrow();
  });
  test("non-JSON and non-object indexes throw", () => {
    expect(() => checkLivenessKey("not json", KEY)).toThrow();
    expect(() => checkLivenessKey("[]", KEY)).toThrow();
    expect(() => checkLivenessKey("null", KEY)).toThrow();
  });
});

describe("liveness-key-check.ts as a script", () => {
  const run = async (key: string, livenessKey: string) => {
    const dir = mkdtempSync(join(tmpdir(), "liveness-check-"));
    try {
      mkdirSync(join(dir, "registry"));
      writeFileSync(join(dir, "registry", "index.json"), JSON.stringify({ livenessKey }));
      const out = join(dir, "output.txt");
      writeFileSync(out, "");
      const proc = Bun.spawn([process.execPath, SCRIPT], {
        cwd: dir,
        env: { ...process.env, KEY: key, GITHUB_OUTPUT: out },
        stdout: "pipe",
        stderr: "pipe",
      });
      const stdout = await new Response(proc.stdout).text();
      const code = await proc.exited;
      return { stdout, code, output: readFileSync(out, "utf8") };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
  test("writes needed=false for a matching key", async () => {
    const r = await run(KEY, KEY);
    expect(r.code).toBe(0);
    expect(r.output).toBe("needed=false\n");
  });
  test("writes needed=true for a different key", async () => {
    const r = await run(KEY, OTHER);
    expect(r.code).toBe(0);
    expect(r.output).toBe("needed=true\n");
  });
  test("an empty KEY exits 1 with an ::error:: line", async () => {
    const r = await run("", KEY);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("::error::");
  });
});

describe("liveness-key-check.ts imports", () => {
  test("only node: builtins", () => {
    const src = readFileSync(SCRIPT, "utf8");
    const specs = [
      ...src.matchAll(/^\s*(?:import|export)\b[^;]*?\bfrom\s+["']([^"']+)["']/gms),
      ...src.matchAll(/^\s*import\s+["']([^"']+)["']/gm),
      ...src.matchAll(/\b(?:import|require)\(\s*["']([^"']+)["']\s*\)/g),
    ].map((m) => m[1]);
    expect(specs.length).toBeGreaterThan(0);
    expect(specs.filter((s) => !s?.startsWith("node:"))).toEqual([]);
  });
});
