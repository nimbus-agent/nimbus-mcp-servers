import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

import {
  detectBunSpawn,
  nimbusSpawn,
  selectSpawnImpl,
  spawnViaBun,
  spawnViaNode,
} from "./nimbus-spawn.ts";

const IMPLS = [
  ["nimbusSpawn (runtime-selected)", nimbusSpawn],
  ["spawnViaBun", spawnViaBun],
  // The suite runs under Bun, so without an explicit case this branch — the one the standalone
  // npx artifact actually uses — would never execute.
  ["spawnViaNode", spawnViaNode],
] as const;

const NUL = String.fromCharCode(0);

describe.each(IMPLS)("%s", (_label, nimbusSpawn) => {
  test("an argument no process can be given resolves as a failure, never rejects", async () => {
    // A NUL byte cannot be passed to a child at all, so the spawn API THROWS on it, where a missing
    // binary fails as an event. Node's spawn threw out of the promise executor, and the promise
    // rejected: the one outcome this contract rules out.
    const r = await nimbusSpawn([process.execPath, "-e", "1", `a${NUL}b`], {});
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("null bytes");
  });

  test("captures stdout and a zero exit", async () => {
    const r = await nimbusSpawn([process.execPath, "-e", "console.log('hi')"], {});
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe("hi");
  });

  test("captures stderr and a non-zero exit", async () => {
    const r = await nimbusSpawn(
      [process.execPath, "-e", "console.error('boom'); process.exit(3)"],
      {},
    );
    expect(r.code).toBe(3);
    expect(r.stderr).toContain("boom");
  });

  test("passes env through", async () => {
    const r = await nimbusSpawn(
      [process.execPath, "-e", "console.log(process.env.NIMBUS_TEST_VAL)"],
      { NIMBUS_TEST_VAL: "set" },
    );
    expect(r.stdout.trim()).toBe("set");
  });

  test("an empty command is refused rather than spawned", async () => {
    const r = await nimbusSpawn([], {});
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("empty command");
  });

  test("a command that does not exist resolves with an error, never rejects", async () => {
    const r = await nimbusSpawn(["definitely-not-a-real-binary-xyz"], {});
    expect(r.code).not.toBe(0);
  });

  test("output above 1MB is NOT truncated — the execFile maxBuffer trap", async () => {
    const r = await nimbusSpawn(
      [process.execPath, "-e", "process.stdout.write('x'.repeat(2_000_000))"],
      {},
    );
    expect(r.code).toBe(0);
    expect(r.stdout).toHaveLength(2_000_000);
  });

  test("multi-byte UTF-8 spanning chunk boundaries is not corrupted", async () => {
    // The previous case is pure ASCII and cannot catch per-chunk decoding. This one can: a large
    // run of 3-byte characters guarantees some character straddles a pipe chunk boundary.
    const r = await nimbusSpawn(
      [process.execPath, "-e", "process.stdout.write('豆'.repeat(400_000))"],
      {},
    );
    expect(r.code).toBe(0);
    expect(r.stdout).toHaveLength(400_000);
    // U+FFFD REPLACEMENT CHARACTER is what per-chunk decoding produces at a split boundary.
    expect(r.stdout).not.toContain("�");
  });

  test("a child killed by a signal resolves as a numbered failure, never a null code", async () => {
    // On Linux and macOS `child_process` reports a signalled child's code as null, and only the
    // `?? 1` turns that into the number the contract promises; Bun reports 128 + the signal there.
    // Windows has no signals to deliver, so the kill is a plain exit there and the code is 1.
    const r = await nimbusSpawn(
      [process.execPath, "-e", "process.kill(process.pid, 'SIGKILL')"],
      {},
    );
    expect(r.code).toBeNumber();
    expect(r.code).not.toBe(0);
  });
});

describe("runtime selection", () => {
  test("detects Bun.spawn on a global that has it, and its absence on one that does not", () => {
    // Bun's global is non-writable AND non-configurable, so it cannot be stubbed. Passing the
    // global in is what makes the "absent" side — the one the npx artifact always takes —
    // reachable at all from a suite running under Bun.
    expect(detectBunSpawn({ Bun: { spawn: () => undefined } })).toBe(true);
    expect(detectBunSpawn({})).toBe(false);
    expect(detectBunSpawn({ Bun: {} })).toBe(false);
    expect(detectBunSpawn()).toBe(true); // the real global, under Bun
  });

  test("routes to the Node implementation on a global without Bun.spawn", async () => {
    const impl = selectSpawnImpl({});
    expect(impl).toBe(spawnViaNode);
    const r = await impl([process.execPath, "-e", "console.log('via-node')"], {});
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe("via-node");
  });

  test("routes to the Bun implementation on a global that has Bun.spawn", async () => {
    const impl = selectSpawnImpl({ Bun: { spawn: () => undefined } });
    expect(impl).toBe(spawnViaBun);
    const r = await impl([process.execPath, "-e", "console.log('via-bun')"], {});
    expect(r.stdout.trim()).toBe("via-bun");
  });

  test("nimbusSpawn routes through the real global", async () => {
    const r = await nimbusSpawn([process.execPath, "-e", "console.log('via-default')"], {});
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe("via-default");
  });
});

/**
 * The real thing, end to end: a `.cmd` on PATH, spawned by name and by path through every
 * implementation, the way `az` and `gcloud` are on Windows. Each hostile argument here was run
 * through the same shim with the refusal removed, and did what its label says — an injected
 * `echo` ran, or the variable's value reached the batch file — so the refusal is what stops it.
 *
 * The benign case runs first for every implementation and name form, and is what keeps the
 * refusals from passing vacuously: it proves this spawn really does reach a batch file, through
 * this PATH, from this runtime. Were the shim never found, every refusal would still "pass".
 */
describe.skipIf(process.platform !== "win32")(
  "a CLI that starts a Windows batch file (skipped off Windows: only there is a spawned program's command line parsed again, by cmd.exe)",
  () => {
    const name = `nimbus-batch-shim-${String(process.pid)}`;
    let dir = "";
    let env: Record<string, string> = {};

    beforeAll(() => {
      dir = mkdtempSync(join(tmpdir(), "nimbus-batch-shim-"));
      // The shape of the real az.cmd — the CLI runs inside a parenthesised block — with delayed
      // expansion on, as a batch wrapper may turn it on.
      writeFileSync(
        join(dir, `${name}.cmd`),
        [
          "@echo off",
          "setlocal EnableDelayedExpansion",
          'if exist "%~f0" (',
          "  echo SHIM-RAN:[%*]",
          ")",
          "",
        ].join("\r\n"),
      );
      // Bun resolves a bare name against a variable spelled PATH, and cmd.exe against the first
      // spelling it meets, which on a Windows-launched process is Path: give every spelling the
      // same value, or the two would look in different places.
      const searchPath = `${dir}${delimiter}${process.env["PATH"] ?? ""}`;
      env = { NIMBUS_SHIM_SECRET: "leaked-secret", PATH: searchPath };
      for (const key of Object.keys(process.env)) {
        if (key.toLowerCase() === "path") {
          env[key] = searchPath;
        }
      }
    });

    afterAll(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    const HOSTILE = [
      ["a command separator", "x&echo,NIMBUS-INJECTED"],
      ["a pipe", "x|echo,NIMBUS-INJECTED"],
      ["a quote ending the quoting the runtime added", 'q"&echo NIMBUS-INJECTED&"'],
      ["%-expansion of an environment variable", "%NIMBUS_SHIM_SECRET%"],
      ["%-expansion inside an argument the runtime quotes", "a %NIMBUS_SHIM_SECRET% b"],
      ["!-expansion under delayed expansion", "!NIMBUS_SHIM_SECRET!"],
      ["a parenthesis ending the batch file's block", "rg(prod)"],
      ["an output redirection", "x>NUL"],
      ["an input redirection", "x<NUL"],
      ["a caret escape", "a^b"],
      ["a line break", `x${String.fromCharCode(0x0a)}echo NIMBUS-INJECTED`],
    ] as const;

    for (const [label, impl] of IMPLS) {
      for (const form of ["by name, through PATH", "by path"] as const) {
        const command = (): string => (form === "by path" ? join(dir, `${name}.cmd`) : name);

        test(`${label}, ${form}: an ordinary argument reaches the batch file`, async () => {
          const r = await impl([command(), "webapp", "list", "benign-value"], env);
          expect({ code: r.code, stdout: r.stdout.trim(), stderr: r.stderr }).toEqual({
            code: 0,
            stdout: "SHIM-RAN:[webapp list benign-value]",
            stderr: "",
          });
        });

        test.each(HOSTILE)(
          `${label}, ${form}: refuses %s before cmd.exe sees it`,
          async (_what, value) => {
            const r = await impl([command(), "webapp", value], env);
            expect(r.code).toBe(1);
            expect(r.stderr).toContain(`refused to run ${JSON.stringify(command())}`);
            expect(r.stderr).toContain("Nothing was run.");
            // Nothing started: not the batch file, and so not whatever cmd.exe would have run.
            expect(r.stdout).toBe("");
            expect(r.stderr).not.toContain("NIMBUS-INJECTED");
            expect(r.stderr).not.toContain("leaked-secret");
          },
        );
      }
    }
  },
);
