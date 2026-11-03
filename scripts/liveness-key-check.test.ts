import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkLivenessKey, runLivenessKeyCheck } from "./liveness-key-check.ts";

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

describe("runLivenessKeyCheck", () => {
  const withIndex = (body: string | undefined, fn: (dir: string, out: string) => void): void => {
    const dir = mkdtempSync(join(tmpdir(), "liveness-run-"));
    try {
      if (body !== undefined) {
        mkdirSync(join(dir, "registry"));
        writeFileSync(join(dir, "registry", "index.json"), body);
      }
      const out = join(dir, "output.txt");
      writeFileSync(out, "");
      fn(dir, out);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  test("a new key: needed=true, exit 0, says the set-key job will run", () => {
    withIndex(JSON.stringify({ sequence: 1 }), (dir, out) => {
      const lines: string[] = [];
      expect(runLivenessKeyCheck({ KEY, GITHUB_OUTPUT: out }, dir, (l) => lines.push(l))).toBe(0);
      expect(readFileSync(out, "utf8")).toBe("needed=true\n");
      expect(lines).toEqual([expect.stringContaining("set-key job will run")]);
    });
  });

  test("the key already named: needed=false, exit 0", () => {
    withIndex(JSON.stringify({ livenessKey: KEY }), (dir, out) => {
      const lines: string[] = [];
      expect(runLivenessKeyCheck({ KEY, GITHUB_OUTPUT: out }, dir, (l) => lines.push(l))).toBe(0);
      expect(readFileSync(out, "utf8")).toBe("needed=false\n");
      expect(lines).toEqual([expect.stringContaining("nothing to do")]);
    });
  });

  test("no GITHUB_OUTPUT still decides and logs", () => {
    withIndex(JSON.stringify({}), (dir, out) => {
      const lines: string[] = [];
      expect(runLivenessKeyCheck({ KEY }, dir, (l) => lines.push(l))).toBe(0);
      expect(readFileSync(out, "utf8")).toBe("");
      expect(lines).toHaveLength(1);
    });
  });

  test("an unset KEY: exit 1, an ::error:: line naming the variable, no output", () => {
    withIndex(JSON.stringify({}), (dir, out) => {
      const lines: string[] = [];
      expect(runLivenessKeyCheck({ GITHUB_OUTPUT: out }, dir, (l) => lines.push(l))).toBe(1);
      expect(lines).toEqual([
        expect.stringMatching(/^::error::.*NIMBUS_REGISTRY_LIVENESS_PUBLIC_KEY/),
      ]);
      expect(readFileSync(out, "utf8")).toBe("");
    });
  });

  test("a missing index: exit 1 with an ::error:: line", () => {
    withIndex(undefined, (dir, out) => {
      const lines: string[] = [];
      expect(runLivenessKeyCheck({ KEY, GITHUB_OUTPUT: out }, dir, (l) => lines.push(l))).toBe(1);
      expect(lines[0]).toStartWith("::error::");
    });
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
