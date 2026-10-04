import { describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { stubSpawn, withEnv } from "./connector-tool-harness.ts";
import {
  findSandboxTests,
  runBanner,
  runSandboxContract,
  type SandboxRunDeps,
} from "./run-sandbox-contract.ts";

describe("findSandboxTests", () => {
  test("finds every connector's sandbox test in the real tree", async () => {
    const files = await findSandboxTests();
    // The point of the runner is that it discovers the set rather than carrying a list that
    // goes stale as connectors are added, so this asserts the shape, not a count.
    expect(files.length).toBeGreaterThan(50);
    expect(files.every((f) => f.endsWith("/test/sandbox.test.ts"))).toBe(true);
    expect(files.every((f) => f.startsWith("connectors/"))).toBe(true);
    // Sorted, so a failing run is diffable against a previous one.
    expect(files).toEqual([...files].sort());
  });

  test("returns forward slashes on every platform", async () => {
    // The paths are handed to `bun test` as argv. A Windows-separator path would still work
    // there, but the assertions above and any caller filtering on "/test/" would not
    // (Non-Negotiable 5: platform equality).
    const files = await findSandboxTests();
    expect(files.some((f) => f.includes("\\"))).toBe(false);
  });

  test("finds nothing in a tree with no connectors, rather than throwing", async () => {
    // The runner treats empty as a hard error and exits 1; that only reads correctly if the
    // discovery itself returns [] instead of blowing up.
    const root = mkdtempSync(join(tmpdir(), "nimbus-sandbox-scan-"));
    mkdirSync(join(root, "connectors"), { recursive: true });
    expect(await findSandboxTests(root)).toEqual([]);
  });

  test("matches only the sandbox test, not a connector's other tests", async () => {
    const root = mkdtempSync(join(tmpdir(), "nimbus-sandbox-scan-"));
    const testDir = join(root, "connectors", "demo", "test");
    mkdirSync(testDir, { recursive: true });
    writeFileSync(join(testDir, "sandbox.test.ts"), "");
    writeFileSync(join(testDir, "server.test.ts"), "");
    writeFileSync(join(testDir, "sandbox-helpers.test.ts"), "");
    expect(await findSandboxTests(root)).toEqual(["connectors/demo/test/sandbox.test.ts"]);
  });
});

describe("runSandboxContract", () => {
  const REPO_ROOT = resolve(import.meta.dir, "..");

  interface Spawned {
    readonly argv: string[];
    readonly cwd: string;
    readonly env: Record<string, string | undefined>;
  }

  /** Recording deps: discovery answers `found`, and the spawned run exits with `exitCode`. */
  function deps(
    found: string[],
    exitCode = 0,
  ): { deps: SandboxRunDeps; spawned: Spawned[]; logged: string[] } {
    const spawned: Spawned[] = [];
    const logged: string[] = [];
    return {
      spawned,
      logged,
      deps: {
        findTests: () => Promise.resolve(found),
        spawn: (argv, opts) => {
          spawned.push({ argv, cwd: opts.cwd, env: opts.env });
          return { exited: Promise.resolve(exitCode) };
        },
        log: (line) => {
          logged.push(line);
        },
      },
    };
  }

  test("refuses to run, and spawns nothing, when discovery finds no sandbox test", async () => {
    const d = deps([]);
    expect(await runSandboxContract([], d.deps)).toBe(1);
    expect(d.spawned).toEqual([]);
    expect(d.logged).toEqual([
      `No sandbox tests matched connectors/*/test/sandbox.test.ts under ${REPO_ROOT}.`,
    ]);
  });

  test("runs every discovered file under bun test from the repo root, with the harness flag", async () => {
    const d = deps(["connectors/a/test/sandbox.test.ts", "connectors/b/test/sandbox.test.ts"], 3);
    // The flag is forced on even when the caller's environment says otherwise; everything else
    // in the environment is passed through.
    await withEnv({ NIMBUS_TEST_HARNESS: "0", NIMBUS_SANDBOX_PROBE_MARKER: "kept" }, async () => {
      // The run's own exit code is what the script exits with.
      expect(await runSandboxContract([], d.deps)).toBe(3);
    });
    expect(d.logged).toEqual([runBanner(2)]);
    expect(d.spawned).toHaveLength(1);
    const [run] = d.spawned;
    expect(run?.argv).toEqual([
      "bun",
      "test",
      join("connectors", "a", "test", "sandbox.test.ts"),
      join("connectors", "b", "test", "sandbox.test.ts"),
    ]);
    expect(run?.cwd).toBe(REPO_ROOT);
    expect(run?.env["NIMBUS_TEST_HARNESS"]).toBe("1");
    expect(run?.env["NIMBUS_SANDBOX_PROBE_MARKER"]).toBe("kept");
  });

  test("extra argv scopes the run to exactly those paths", async () => {
    const d = deps(["connectors/a/test/sandbox.test.ts", "connectors/b/test/sandbox.test.ts"]);
    expect(await runSandboxContract(["connectors/b/test/sandbox.test.ts"], d.deps)).toBe(0);
    expect(d.spawned.map((s) => s.argv)).toEqual([
      ["bun", "test", "connectors/b/test/sandbox.test.ts"],
    ]);
  });

  test("with its real dependencies, runs every discovered test and announces it on stderr", async () => {
    // The dependencies `bun run test:sandbox` actually gets: the real discovery, Bun.spawn and
    // console.error. Only Bun.spawn is stubbed, so nothing starts the live-network suite — the
    // wiring that hands the run its harness flag is the production one.
    const found = await findSandboxTests();
    const spawn = stubSpawn({ exitCode: 4 });
    const banner = spyOn(console, "error").mockImplementation(() => undefined);
    let code: number | undefined;
    let logged: unknown[][] = [];
    try {
      code = await runSandboxContract([]);
      logged = [...banner.mock.calls];
    } finally {
      spawn.restore();
      banner.mockRestore();
    }
    expect(code).toBe(4);
    expect(logged).toEqual([[runBanner(found.length)]]);
    expect(spawn.calls).toHaveLength(1);
    expect(spawn.calls[0]?.command).toEqual([
      "bun",
      "test",
      ...found.map((f) => join(...f.split("/"))),
    ]);
    expect(spawn.calls[0]?.env["NIMBUS_TEST_HARNESS"]).toBe("1");
  });
});
