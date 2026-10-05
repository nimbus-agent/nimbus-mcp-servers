import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import {
  batchArgumentRefusal,
  cmdMetacharacterIn,
  isBatchFileName,
  mayRunAsBatchFile,
} from "./windows-batch-args.ts";

/**
 * These run on every OS: the filesystem and the platform are injected, so the Windows rule is
 * verified on the Linux leg that measures coverage too. Two things only Windows can show: whether
 * the lookup modelled here is the one Bun really does — the Windows-only block at the end — and
 * the refusal end to end, a `.cmd` on PATH spawned through `nimbusSpawn`, which is
 * `nimbus-spawn.test.ts`'s.
 */

const LF = String.fromCharCode(0x0a);
const CR = String.fromCharCode(0x0d);
const TAB = String.fromCharCode(0x09);
const NUL = String.fromCharCode(0);

const CWD = "C:\\work";

/** An `exists` that knows exactly these paths, compared case-insensitively as NTFS does. */
function fsWith(...paths: string[]): (path: string) => boolean {
  const known = new Set(paths.map((p) => p.toLowerCase()));
  return (path) => known.has(path.toLowerCase());
}

/** An `exists` that fails the test if it is consulted at all. */
function untouchedFs(path: string): boolean {
  throw new Error(`the filesystem was consulted for ${path}`);
}

describe("cmdMetacharacterIn", () => {
  test("finds nothing in the values the connectors pass", () => {
    for (const value of [
      "my-rg_1.prod",
      "gcr.io/p1/api:2",
      "us-docker.pkg.dev/p/r/img@sha256:abc123",
      "/aws/lambda/my-fn#1",
      "arn:aws:ecs:us-east-1:123456789012:cluster/c1",
      "00000000-0000-4000-8000-000000000000",
      "has a space",
      "user@example.com",
      "a,b;c=d",
      "RUNNER~1",
      "C:\\Users\\me\\AppData\\Local\\Temp\\nimbus-aws-lambda-x\\payload.json",
    ]) {
      expect({ value, found: cmdMetacharacterIn(value) }).toEqual({ value, found: undefined });
    }
  });

  test("finds each character cmd.exe acts on, wherever it sits", () => {
    for (const ch of ["%", "!", '"', "&", "|", "<", ">", "^", "(", ")"]) {
      expect(cmdMetacharacterIn(`${ch}start`)).toBe(ch);
      expect(cmdMetacharacterIn(`mid${ch}dle`)).toBe(ch);
      expect(cmdMetacharacterIn(`end${ch}`)).toBe(ch);
    }
  });

  test("finds a line break or any other control character", () => {
    for (const ch of [LF, CR, TAB, NUL, String.fromCharCode(0x1f)]) {
      expect(cmdMetacharacterIn(`a${ch}b`)).toBe(ch);
    }
  });

  test("reports the first offending character", () => {
    expect(cmdMetacharacterIn("a&b|c")).toBe("&");
    expect(cmdMetacharacterIn("a%PATH%&b")).toBe("%");
  });
});

describe("isBatchFileName", () => {
  test("is true for a .cmd or .bat, in any case and with any directory", () => {
    for (const name of [
      "az.cmd",
      "AZ.CMD",
      "gcloud.Cmd",
      "x.bat",
      "C:\\tools\\az.cmd",
      "./az.bat",
    ]) {
      expect({ name, batch: isBatchFileName(name) }).toEqual({ name, batch: true });
    }
  });

  test("is true with the trailing dots and spaces Windows drops from a file name", () => {
    for (const name of ["az.cmd.", "az.cmd ", "az.bat. .", "az.cmd..."]) {
      expect({ name, batch: isBatchFileName(name) }).toEqual({ name, batch: true });
    }
  });

  test("is false for anything else", () => {
    for (const name of ["az", "az.exe", "az.cmd.exe", "cmd", "az.cmdx", "batch", "az.com"]) {
      expect({ name, batch: isBatchFileName(name) }).toEqual({ name, batch: false });
    }
  });
});

describe("mayRunAsBatchFile", () => {
  /** `mayRunAsBatchFile` against a filesystem holding exactly `exists`, in {@link CWD}. */
  function may(
    bin: string,
    env: Record<string, string | undefined>,
    exists: (path: string) => boolean,
  ): boolean {
    return mayRunAsBatchFile(bin, env, { exists, cwd: CWD });
  }

  test("a name that is itself a batch file is one, without looking at the filesystem", () => {
    expect(may("C:\\tools\\az.cmd", {}, untouchedFs)).toBe(true);
    expect(may("az.bat", {}, untouchedFs)).toBe(true);
  });

  test("a name ending in .exe is not one, without looking at the filesystem", () => {
    // Bun looks such a name up as written, and no runtime hands an .exe to cmd.exe.
    expect(may("aws.exe", { PATH: "C:\\bin" }, untouchedFs)).toBe(false);
    expect(may("C:\\x\\kubectl.EXE", { PATH: "C:\\bin" }, untouchedFs)).toBe(false);
  });

  test("a name ending in .com is looked up like any other, so a .com.cmd counts", () => {
    // Bun appends .exe, .cmd and .bat to every name that does not already end in one of them.
    expect(may("tool.com", { PATH: "C:\\bin" }, fsWith("C:\\bin\\tool.com.cmd"))).toBe(true);
    expect(may("tool.com", { PATH: "C:\\bin" }, fsWith("C:\\bin\\tool.com"))).toBe(false);
  });

  test("the first directory on PATH that holds the name decides", () => {
    const env = { PATH: "C:\\first;C:\\second" };
    // The AWS CLI v2 installer's aws.exe ahead of a leftover pip-installed v1's aws.cmd: Bun runs
    // the .exe, and nothing after it on PATH matters.
    expect(may("aws", env, fsWith("C:\\first\\aws.exe", "C:\\second\\aws.cmd"))).toBe(false);
    expect(may("aws", env, fsWith("C:\\first\\aws.cmd", "C:\\second\\aws.exe"))).toBe(true);
    expect(may("aws", env, fsWith("C:\\second\\aws.bat"))).toBe(true);
    expect(may("aws", env, fsWith("C:\\second\\aws.exe"))).toBe(false);
  });

  test("a .cmd or .bat beside an .exe in that first directory still counts", () => {
    // Bun tries .exe first and would run it; this does not lean on that order.
    const env = { PATH: "C:\\first" };
    expect(may("aws", env, fsWith("C:\\first\\aws.exe", "C:\\first\\aws.cmd"))).toBe(true);
    expect(may("aws", env, fsWith("C:\\first\\aws.exe", "C:\\first\\aws.bat"))).toBe(true);
  });

  test("a name found nowhere is not one", () => {
    expect(may("az", { PATH: "C:\\a;C:\\b" }, () => false)).toBe(false);
  });

  test("without a PATH variable that is set and not empty nothing is looked up, and it is not one", () => {
    // Bun hands such a name to libuv, which starts only a .com or an .exe.
    for (const env of [{}, { PATH: "" }, { Path: "" }, { PATH: undefined }, { HOME: "C:\\x" }]) {
      expect({ env, batch: may("az", env, untouchedFs) }).toEqual({ env, batch: false });
      expect({ env, batch: may("C:\\sdk\\bin\\gcloud", env, untouchedFs) }).toEqual({
        env,
        batch: false,
      });
    }
  });

  test("the variable counts in every spelling, though Bun reads only PATH", () => {
    for (const key of ["PATH", "Path", "path"]) {
      expect(may("gcloud", { [key]: "C:\\sdk\\bin" }, fsWith("C:\\sdk\\bin\\gcloud.cmd"))).toBe(
        true,
      );
    }
  });

  test("each spelling is searched on its own, and a batch file found first on any one counts", () => {
    const exists = fsWith("C:\\exe\\az.exe", "C:\\cmd\\az.cmd");
    expect(may("az", { PATH: "C:\\exe", Path: "C:\\cmd" }, exists)).toBe(true);
    expect(may("az", { PATH: "C:\\cmd", Path: "C:\\exe" }, exists)).toBe(true);
    expect(may("az", { PATH: "C:\\exe", Path: "C:\\exe;C:\\cmd" }, exists)).toBe(false);
  });

  test("entries are searched as written and, separately, without quotes and whitespace", () => {
    // Bun reads an entry as written, so it never finds anything behind quotes; cmd.exe strips them.
    const env = { PATH: `C:\\a; "C:\\Program Files\\Azure" ;C:\\b` };
    expect(may("az", env, fsWith("C:\\Program Files\\Azure\\az.cmd"))).toBe(true);
    // Stripped, the quoted entry holds an .exe ahead of C:\b's batch file; as written, it is
    // passed over, and C:\b's batch file is found first.
    expect(may("az", env, fsWith("C:\\Program Files\\Azure\\az.exe", "C:\\b\\az.cmd"))).toBe(true);
    expect(may("az", env, fsWith("C:\\a\\az.exe", "C:\\b\\az.cmd"))).toBe(false);
  });

  test("an empty entry is skipped", () => {
    expect(may("az", { PATH: ";;C:\\a;" }, fsWith("C:\\a\\az.cmd"))).toBe(true);
  });

  test("a relative PATH entry is resolved against the current directory", () => {
    expect(may("az", { PATH: "tools" }, fsWith("C:\\work\\tools\\az.cmd"))).toBe(true);
  });

  test("the current directory itself is not searched for a bare name", () => {
    // Bun never looks there: a batch file in it is not found, and nothing runs.
    expect(may("az", { PATH: "C:\\bin" }, fsWith("C:\\work\\az.cmd"))).toBe(false);
  });

  test("a name with a directory is looked up in that directory alone, never on PATH", () => {
    const env = { PATH: "C:\\bin" };
    expect(may("tools\\az", env, fsWith("C:\\work\\tools\\az.cmd"))).toBe(true);
    expect(may("tools\\az", env, fsWith("C:\\bin\\tools\\az.cmd", "C:\\bin\\az.cmd"))).toBe(false);
    expect(may("C:\\sdk\\bin\\gcloud", env, fsWith("C:\\sdk\\bin\\gcloud.cmd"))).toBe(true);
    expect(may("C:\\sdk\\bin\\gcloud", env, fsWith("C:\\sdk\\bin\\gcloud.exe"))).toBe(false);
    // Bun hands a name written with / to libuv instead, which starts no batch file; it is looked
    // up here all the same.
    expect(may("C:/sdk/bin/gcloud", env, fsWith("C:\\sdk\\bin\\gcloud.cmd"))).toBe(true);
  });

  test("only the spawn environment's PATH is searched, in Bun's order, and never this process's", () => {
    const looked: string[] = [];
    mayRunAsBatchFile(
      "nimbus-batch-probe",
      { PATH: "C:\\elsewhere;C:\\later" },
      {
        exists: (path) => {
          looked.push(path);
          return false;
        },
        cwd: CWD,
      },
    );
    expect(looked).toEqual([
      "C:\\elsewhere\\nimbus-batch-probe.exe",
      "C:\\elsewhere\\nimbus-batch-probe.cmd",
      "C:\\elsewhere\\nimbus-batch-probe.bat",
      "C:\\later\\nimbus-batch-probe.exe",
      "C:\\later\\nimbus-batch-probe.cmd",
      "C:\\later\\nimbus-batch-probe.bat",
    ]);
  });
});

describe("batchArgumentRefusal", () => {
  const BATCH = "C:\\Azure\\wbin\\az.cmd";

  test("refuses a batch file whose arguments hold a character cmd.exe acts on", () => {
    const refusal = batchArgumentRefusal(
      [BATCH, "webapp", "list", "x&calc"],
      {},
      {
        platform: "win32",
        exists: untouchedFs,
        cwd: CWD,
      },
    );
    expect(refusal).toBe(
      `refused to run ${JSON.stringify(BATCH)}: it may start a Windows batch file, which ` +
        "cmd.exe parses again before the CLI sees its arguments, and argument 3 holds " +
        '"&", which cmd.exe would act on. Nothing was run.',
    );
  });

  test("names a control character by its code point, and never quotes the value", () => {
    const refusal = batchArgumentRefusal(
      [BATCH, `secret-value${LF}next`],
      {},
      {
        platform: "win32",
        cwd: CWD,
      },
    );
    expect(refusal).toContain("argument 1 holds the control character U+000A");
    expect(refusal).not.toContain("secret-value");
  });

  test("refuses a bare name that resolves to a batch file on the spawn environment's PATH", () => {
    expect(
      batchArgumentRefusal(
        ["az", "--resource-group", "%AZURE_CLIENT_SECRET%"],
        {
          Path: "C:\\Azure\\wbin",
        },
        { platform: "win32", exists: fsWith("C:\\Azure\\wbin\\az.cmd"), cwd: CWD },
      ),
    ).toContain('argument 2 holds "%"');
  });

  test("lets a batch file's ordinary arguments through", () => {
    expect(
      batchArgumentRefusal(
        [BATCH, "webapp", "list", "--resource-group", "rg-1", "-o", "json"],
        {},
        {
          platform: "win32",
          exists: untouchedFs,
          cwd: CWD,
        },
      ),
    ).toBeUndefined();
  });

  test("judges the file that runs: an .exe found before a batch file of its name is let through", () => {
    // The AWS CLI v2 installer's aws.exe ahead of a leftover pip-installed v1's aws.cmd: Bun runs
    // the .exe, so a template body full of quotes reaches it untouched. Swap the two directories,
    // and the batch file is what would run.
    const exists = fsWith("C:\\v2\\aws.exe", "C:\\py\\Scripts\\aws.cmd");
    const command = ["aws", "cloudformation", "deploy", "--template-body", '{"a":1}'];
    expect(
      batchArgumentRefusal(
        command,
        { PATH: "C:\\v2;C:\\py\\Scripts" },
        { platform: "win32", exists, cwd: CWD },
      ),
    ).toBeUndefined();
    expect(
      batchArgumentRefusal(
        command,
        { PATH: "C:\\py\\Scripts;C:\\v2" },
        { platform: "win32", exists, cwd: CWD },
      ),
    ).toContain('argument 4 holds "\\""');
  });

  test("lets any argument through to a program that is not a batch file", () => {
    // aws.exe receives a CloudFormation template body full of quotes; no shell parses it again.
    expect(
      batchArgumentRefusal(
        ["aws.exe", "--template-body", '{"Resources":{}}'],
        {},
        {
          platform: "win32",
          exists: untouchedFs,
          cwd: CWD,
        },
      ),
    ).toBeUndefined();
    expect(
      batchArgumentRefusal(
        ["aws", "--template-body", '{"a":1}'],
        { PATH: "C:\\aws" },
        {
          platform: "win32",
          exists: fsWith("C:\\aws\\aws.exe"),
          cwd: CWD,
        },
      ),
    ).toBeUndefined();
  });

  test("looks at the filesystem only when an argument would otherwise be refused", () => {
    expect(
      batchArgumentRefusal(
        ["az", "webapp", "list"],
        { PATH: "C:\\Azure\\wbin" },
        {
          platform: "win32",
          exists: untouchedFs,
          cwd: CWD,
        },
      ),
    ).toBeUndefined();
  });

  test("applies on Windows only, where a spawned program's arguments are parsed again", () => {
    for (const platform of ["linux", "darwin"] as const) {
      expect(
        batchArgumentRefusal([BATCH, "x&calc"], {}, { platform, exists: untouchedFs, cwd: CWD }),
      ).toBeUndefined();
    }
  });

  test("has nothing to say about an empty command", () => {
    expect(
      batchArgumentRefusal([], {}, { platform: "win32", exists: untouchedFs }),
    ).toBeUndefined();
  });

  test("defaults to this process's platform", () => {
    const refusal = batchArgumentRefusal([BATCH, "x&calc"], {});
    expect(refusal === undefined).toBe(process.platform !== "win32");
  });
});

/**
 * The lookup modelled above, against the real one. Each layout puts harmless stand-ins in a fresh
 * temp dir — a copy of hostname.exe, and batch files that echo their own name — and starts the
 * program through `Bun.spawn` and through `node:child_process`, which Bun builds on it, with one
 * argument: `x&echo,CMD-PARSED`. Only cmd.exe parsing the command line runs that `echo`, and that
 * parse is exactly what `mayRunAsBatchFile` predicts. So each layout pins what Bun does — a change
 * in a later Bun fails here rather than going unnoticed — and what the model says of it.
 *
 * The model may say yes where Bun starts no batch file: those are its deliberate margins, each
 * named below. It must never say no where one ran. And the layouts in which a batch file runs are
 * what keep this from passing vacuously: were batch files never started here, they would fail.
 */
describe.skipIf(process.platform !== "win32")(
  "mayRunAsBatchFile against Bun's own lookup (skipped off Windows: only there does a spawn start a batch file through cmd.exe)",
  () => {
    const HOSTNAME = join(process.env["SystemRoot"] ?? "C:\\Windows", "System32", "hostname.exe");
    const MARK = "CMD-PARSED";
    const ARGUMENT = `x&echo,${MARK}`;

    interface Layout {
      readonly name: string;
      /** Files under the layout's directory: an `.exe` is a copy of hostname.exe, the rest echo. */
      readonly files: readonly string[];
      /** Directories to create, some named like the program. */
      readonly dirs?: readonly string[];
      /** The program, given the layout's directory: a bare name, or a path in it. */
      readonly program: (dir: string) => string;
      readonly env: (dir: string) => Record<string, string>;
      /** The spawn's working directory, under the layout's directory. */
      readonly cwd?: string;
      /** Whether Bun starts a batch file: measured, and pinned. */
      readonly bunStartsBatch: boolean;
      /** What `mayRunAsBatchFile` says. */
      readonly predicted: boolean;
    }

    const at = (dir: string, ...parts: string[]): string => join(dir, ...parts);
    const bare = (): string => "ordx";

    const LAYOUTS: readonly Layout[] = [
      {
        name: "an .exe found first on PATH, a .cmd after it: the .exe runs",
        files: ["first/ordx.exe", "second/ordx.cmd"],
        program: bare,
        env: (d) => ({ PATH: `${at(d, "first")};${at(d, "second")}` }),
        bunStartsBatch: false,
        predicted: false,
      },
      {
        name: "a .cmd found first on PATH, an .exe after it: the .cmd runs",
        files: ["first/ordx.cmd", "second/ordx.exe"],
        program: bare,
        env: (d) => ({ PATH: `${at(d, "first")};${at(d, "second")}` }),
        bunStartsBatch: true,
        predicted: true,
      },
      {
        name: "a .bat alone",
        files: ["first/ordx.bat"],
        program: bare,
        env: (d) => ({ PATH: at(d, "first") }),
        bunStartsBatch: true,
        predicted: true,
      },
      {
        name: "a .cmd beside a .bat",
        files: ["first/ordx.cmd", "first/ordx.bat"],
        program: bare,
        env: (d) => ({ PATH: at(d, "first") }),
        bunStartsBatch: true,
        predicted: true,
      },
      {
        name: "a .cmd only in the current directory: nothing runs",
        files: ["work/ordx.cmd"],
        dirs: ["empty"],
        program: bare,
        env: (d) => ({ PATH: at(d, "empty") }),
        cwd: "work",
        bunStartsBatch: false,
        predicted: false,
      },
      {
        name: "a name ending in .com, looked up like any other",
        files: ["first/ordx.com.cmd"],
        program: () => "ordx.com",
        env: (d) => ({ PATH: at(d, "first") }),
        bunStartsBatch: true,
        predicted: true,
      },
      {
        name: "a directory named like the program is passed over",
        files: ["second/ordx.cmd"],
        dirs: ["first/ordx.exe"],
        program: bare,
        env: (d) => ({ PATH: `${at(d, "first")};${at(d, "second")}` }),
        bunStartsBatch: true,
        predicted: true,
      },
      {
        name: "a path written with a backslash and no extension",
        files: ["first/ordx.cmd"],
        dirs: ["empty"],
        program: (d) => at(d, "first", "ordx"),
        env: (d) => ({ PATH: at(d, "empty") }),
        bunStartsBatch: true,
        predicted: true,
      },
      {
        name: "an explicit .cmd path, with no variable spelled PATH",
        files: ["first/ordx.cmd"],
        program: (d) => at(d, "first", "ordx.cmd"),
        env: (d) => ({ Path: at(d, "first") }),
        bunStartsBatch: true,
        predicted: true,
      },
      {
        name: "an explicit .cmd path with a trailing dot, which Windows drops",
        files: ["first/ordx.cmd"],
        program: (d) => `${at(d, "first", "ordx.cmd")}.`,
        env: (d) => ({ Path: at(d, "first") }),
        bunStartsBatch: true,
        predicted: true,
      },
      {
        name: "PATH and Path disagree, PATH holding the .cmd: Bun reads PATH",
        files: ["first/ordx.cmd", "second/ordx.exe"],
        program: bare,
        env: (d) => ({ PATH: at(d, "first"), Path: at(d, "second") }),
        bunStartsBatch: true,
        predicted: true,
      },
      {
        name: "margin: an .exe beside a .cmd in one directory — Bun runs the .exe",
        files: ["first/ordx.exe", "first/ordx.cmd"],
        program: bare,
        env: (d) => ({ PATH: at(d, "first") }),
        bunStartsBatch: false,
        predicted: true,
      },
      {
        name: "margin: only Path is set — Bun starts nothing",
        files: ["first/ordx.cmd"],
        program: bare,
        env: (d) => ({ Path: at(d, "first") }),
        bunStartsBatch: false,
        predicted: true,
      },
      {
        name: "margin: PATH and Path disagree, Path holding the .cmd — Bun reads PATH",
        files: ["first/ordx.exe", "second/ordx.cmd"],
        program: bare,
        env: (d) => ({ PATH: at(d, "first"), Path: at(d, "second") }),
        bunStartsBatch: false,
        predicted: true,
      },
      {
        name: "margin: a quoted PATH entry — Bun passes it over",
        files: ["first/ordx.cmd"],
        program: bare,
        env: (d) => ({ PATH: `"${at(d, "first")}"` }),
        bunStartsBatch: false,
        predicted: true,
      },
      {
        name: "margin: a path written with a slash — Bun hands it to libuv, which starts no .cmd",
        files: ["first/ordx.cmd"],
        dirs: ["empty"],
        program: (d) => at(d, "first", "ordx").replaceAll("\\", "/"),
        env: (d) => ({ PATH: at(d, "empty") }),
        bunStartsBatch: false,
        predicted: true,
      },
    ];

    let root = "";

    beforeAll(() => {
      root = mkdtempSync(join(tmpdir(), "nimbus-batch-lookup-"));
    });

    afterAll(() => {
      rmSync(root, { recursive: true, force: true });
    });

    function stage(dir: string, layout: Layout): void {
      for (const sub of layout.dirs ?? []) {
        mkdirSync(join(dir, sub), { recursive: true });
      }
      for (const file of layout.files) {
        const path = join(dir, file);
        mkdirSync(dirname(path), { recursive: true });
        if (file.endsWith(".exe")) {
          copyFileSync(HOSTNAME, path);
        } else {
          writeFileSync(path, `@echo off\r\necho BATCH-RAN:${basename(file)}\r\n`);
        }
      }
    }

    /** Whether cmd.exe parsed the argument when `Bun.spawn` started `program`. */
    async function parsedViaBunSpawn(
      program: string,
      env: Record<string, string>,
      cwd: string | undefined,
    ): Promise<boolean> {
      try {
        const proc = Bun.spawn([program, ARGUMENT], {
          env,
          ...(cwd === undefined ? {} : { cwd }),
          stdout: "pipe",
          stderr: "pipe",
        });
        await proc.exited;
        return (await new Response(proc.stdout).text()).includes(MARK);
      } catch {
        return false; // nothing to start: Bun found no file
      }
    }

    /** Whether cmd.exe parsed the argument when `node:child_process` started `program`. */
    function parsedViaChildProcess(
      program: string,
      env: Record<string, string>,
      cwd: string | undefined,
    ): Promise<boolean> {
      return new Promise((resolve) => {
        let out = "";
        try {
          const child = spawn(program, [ARGUMENT], { env, cwd });
          child.stdout.on("data", (chunk: Buffer) => {
            out += chunk.toString();
          });
          child.on("error", () => resolve(false));
          child.on("close", () => resolve(out.includes(MARK)));
        } catch {
          resolve(false);
        }
      });
    }

    for (const [index, layout] of LAYOUTS.entries()) {
      test(layout.name, async () => {
        const dir = join(root, String(index));
        mkdirSync(dir);
        stage(dir, layout);
        const program = layout.program(dir);
        const env = { SystemRoot: process.env["SystemRoot"] ?? "C:\\Windows", ...layout.env(dir) };
        const cwd = layout.cwd === undefined ? undefined : join(dir, layout.cwd);
        const viaBunSpawn = await parsedViaBunSpawn(program, env, cwd);
        const viaChildProcess = await parsedViaChildProcess(program, env, cwd);
        const predicted = mayRunAsBatchFile(program, env, cwd === undefined ? {} : { cwd });
        // Never no where a batch file ran: that would be an argument cmd.exe parsed unchecked.
        expect({ ran: viaBunSpawn || viaChildProcess, predicted }).not.toEqual({
          ran: true,
          predicted: false,
        });
        expect({ viaBunSpawn, viaChildProcess, predicted }).toEqual({
          viaBunSpawn: layout.bunStartsBatch,
          viaChildProcess: layout.bunStartsBatch,
          predicted: layout.predicted,
        });
      });
    }
  },
);
