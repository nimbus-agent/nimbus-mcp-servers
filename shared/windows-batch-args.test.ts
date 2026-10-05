import { describe, expect, test } from "bun:test";
import { win32 } from "node:path";
import {
  batchArgumentRefusal,
  cmdMetacharacterIn,
  isBatchFileName,
  mayRunAsBatchFile,
} from "./windows-batch-args.ts";

/**
 * These run on every OS: the filesystem and the platform are injected, so the Windows rule is
 * verified on the Linux leg that measures coverage too. The real thing — a `.cmd` on PATH, spawned
 * through `nimbusSpawn` — is `nimbus-spawn.test.ts`'s Windows-only block.
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
  test("a name that is itself a batch file is one, without looking at the filesystem", () => {
    expect(mayRunAsBatchFile("C:\\tools\\az.cmd", {}, { exists: untouchedFs, cwd: CWD })).toBe(
      true,
    );
    expect(mayRunAsBatchFile("az.bat", {}, { exists: untouchedFs, cwd: CWD })).toBe(true);
  });

  test("a name that is itself an .exe or .com is not, without looking at the filesystem", () => {
    expect(mayRunAsBatchFile("aws.exe", {}, { exists: untouchedFs, cwd: CWD })).toBe(false);
    expect(mayRunAsBatchFile("C:\\x\\kubectl.EXE", {}, { exists: untouchedFs, cwd: CWD })).toBe(
      false,
    );
    expect(mayRunAsBatchFile("tool.com", {}, { exists: untouchedFs, cwd: CWD })).toBe(false);
  });

  test("a bare name is one when a .cmd or .bat of that name is on the environment's PATH", () => {
    const env = { PATH: "C:\\Windows;C:\\Azure\\wbin" };
    expect(
      mayRunAsBatchFile("az", env, { exists: fsWith("C:\\Azure\\wbin\\az.cmd"), cwd: CWD }),
    ).toBe(true);
    expect(
      mayRunAsBatchFile("az", env, { exists: fsWith("C:\\Azure\\wbin\\az.bat"), cwd: CWD }),
    ).toBe(true);
  });

  test("the variable counts in any spelling, because Windows writes it Path", () => {
    for (const key of ["PATH", "Path", "path"]) {
      expect(
        mayRunAsBatchFile(
          "gcloud",
          { [key]: "C:\\sdk\\bin" },
          { exists: fsWith("C:\\sdk\\bin\\gcloud.cmd"), cwd: CWD },
        ),
      ).toBe(true);
    }
  });

  test("a batch file earlier or later than an .exe of the same name still counts", () => {
    // Which of the two a resolver would pick depends on the resolver; this does not guess.
    const env = { PATH: "C:\\first;C:\\second" };
    const exists = fsWith("C:\\first\\aws.exe", "C:\\second\\aws.cmd");
    expect(mayRunAsBatchFile("aws", env, { exists, cwd: CWD })).toBe(true);
  });

  test("a batch file in the current directory counts — cmd.exe looks there first", () => {
    expect(mayRunAsBatchFile("az", {}, { exists: fsWith("C:\\work\\az.cmd"), cwd: CWD })).toBe(
      true,
    );
  });

  test("a PATH entry is tried as written and without surrounding quotes and whitespace", () => {
    const env = { PATH: `C:\\a; "C:\\Program Files\\Azure" ;C:\\b` };
    expect(
      mayRunAsBatchFile("az", env, {
        exists: fsWith("C:\\Program Files\\Azure\\az.cmd"),
        cwd: CWD,
      }),
    ).toBe(true);
  });

  test("a relative PATH entry is resolved against the current directory", () => {
    expect(
      mayRunAsBatchFile(
        "az",
        { PATH: "tools" },
        { exists: fsWith("C:\\work\\tools\\az.cmd"), cwd: CWD },
      ),
    ).toBe(true);
  });

  test("a name with a directory is a path: resolved against the current directory, never PATH", () => {
    const env = { PATH: "C:\\bin" };
    expect(
      mayRunAsBatchFile("tools\\az", env, { exists: fsWith("C:\\work\\tools\\az.cmd"), cwd: CWD }),
    ).toBe(true);
    expect(
      mayRunAsBatchFile("tools\\az", env, { exists: fsWith("C:\\bin\\tools\\az.cmd"), cwd: CWD }),
    ).toBe(false);
    expect(
      mayRunAsBatchFile("C:/sdk/bin/gcloud", env, {
        exists: fsWith("C:\\sdk\\bin\\gcloud.cmd"),
        cwd: CWD,
      }),
    ).toBe(true);
  });

  test("a name found nowhere is not one", () => {
    expect(
      mayRunAsBatchFile("az", { PATH: "C:\\a;;C:\\b" }, { exists: () => false, cwd: CWD }),
    ).toBe(false);
  });

  test("this process's own PATH is searched too, whatever the spawn environment says", () => {
    // The spawn environment may override PATH, or leave it out; a runtime that falls back to the
    // process's own would then find what this process can see. Split as the check splits, on the
    // Windows delimiter, so the expectation holds on the Linux and macOS legs too.
    const firstOwnDir = (process.env["PATH"] ?? "")
      .split(win32.delimiter)
      .find((d) => d.trim() !== "");
    if (firstOwnDir === undefined) {
      throw new Error("this process has no PATH to test against");
    }
    const looked: string[] = [];
    mayRunAsBatchFile(
      "nimbus-batch-probe",
      { PATH: "C:\\elsewhere" },
      {
        exists: (path) => {
          looked.push(path);
          return false;
        },
        cwd: CWD,
      },
    );
    expect(looked).toContain(win32.resolve(CWD, firstOwnDir, "nimbus-batch-probe.cmd"));
    expect(looked).toContain(win32.resolve(CWD, "C:\\elsewhere", "nimbus-batch-probe.cmd"));
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
