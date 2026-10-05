import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  byToolName,
  type CapturedTools,
  captureStandaloneTools,
  captureTools,
  refusalSaying,
  type SpawnStub,
  stubSpawn,
  withEnv,
} from "../../../scripts/connector-tool-harness.ts";
import { resetConnectorModeForTests, setConnectorMode } from "../../../shared/connector-mode.ts";
import { IAC_TOOL_NAMES, registerIacTools } from "../src/tools.ts";

let spawn: SpawnStub | undefined;

/** A CloudFormation template file as the CLI found it when it started. */
type TemplateSeen = { readonly path: string; readonly content: string };

/** Every template file handed to a CLI since the current stub was installed. */
let templatesSeen: TemplateSeen[] = [];

/**
 * Answer every CLI call with this reply, replacing any stub already installed. A template file
 * named by `--template-file` is read at the moment of the call, since it is gone by the time the
 * tool returns.
 */
function cli(reply: { stdout?: string; stderr?: string; exitCode?: number }): SpawnStub {
  spawn?.restore();
  templatesSeen = [];
  spawn = stubSpawn({
    ...reply,
    onSpawn: (command) => {
      const at = command.indexOf("--template-file");
      const path = at === -1 ? undefined : command[at + 1];
      if (path !== undefined) templatesSeen.push({ path, content: readFileSync(path, "utf8") });
    },
  });
  return spawn;
}

/** Stands for the template file's path, which differs on every call, in an expected argv. */
const TEMPLATE_FILE = "<template file>";

/** The commands run, each template file's path replaced by {@link TEMPLATE_FILE}. */
function commandsRun(stub: SpawnStub): string[][] {
  const paths = new Set(templatesSeen.map((t) => t.path));
  return stub.calls.map((c) => c.command.map((arg) => (paths.has(arg) ? TEMPLATE_FILE : arg)));
}

beforeEach(() => {
  resetConnectorModeForTests();
});

afterEach(() => {
  spawn?.restore();
  spawn = undefined;
  resetConnectorModeForTests();
});

/** Every iac tool, the arguments it is called with, and the exact argv it must run. */
const CASES: readonly {
  readonly tool: (typeof IAC_TOOL_NAMES)[number];
  readonly args: Record<string, unknown>;
  readonly argv: readonly string[];
}[] = [
  // terraform reads `-chdir` only as `-chdir=DIR`. Given `-chdir DIR`, terraform 1.16.5 exits 1
  // with "Invalid -chdir option: must include an equals sign followed by a directory path", so all
  // three tools failed on every call.
  {
    tool: "iac_terraform_plan",
    args: { workingDirectory: "infra/prod" },
    argv: ["terraform", "-chdir=infra/prod", "plan", "-input=false"],
  },
  {
    tool: "iac_terraform_apply",
    args: { workingDirectory: "infra/prod" },
    argv: ["terraform", "-chdir=infra/prod", "apply", "-auto-approve", "-input=false"],
  },
  {
    tool: "iac_terraform_destroy",
    args: { workingDirectory: "infra/prod" },
    argv: ["terraform", "-chdir=infra/prod", "destroy", "-auto-approve", "-input=false"],
  },
  // `aws cloudformation deploy` takes the template only as `--template-file`. Given
  // `--template-body`, AWS CLI 2.34.0 refuses with "the following arguments are required:
  // --template-file", so the tool failed on every call.
  {
    tool: "iac_cloudformation_deploy",
    args: { stackName: "web", templateBody: '{"Resources":{}}' },
    argv: [
      "aws",
      "cloudformation",
      "deploy",
      "--stack-name",
      "web",
      "--template-file",
      TEMPLATE_FILE,
      "--capabilities",
      "CAPABILITY_IAM",
      "--no-fail-on-empty-changeset",
    ],
  },
  {
    tool: "iac_pulumi_preview",
    args: { workingDirectory: "stacks/web" },
    argv: ["pulumi", "preview", "--cwd", "stacks/web", "--non-interactive"],
  },
  {
    tool: "iac_pulumi_up",
    args: { workingDirectory: "stacks/web" },
    argv: ["pulumi", "up", "--yes", "--cwd", "stacks/web", "--non-interactive"],
  },
];

/**
 * PATH pointed at `dir()` for every test in a block, so the machine running it cannot decide the
 * outcome: on Windows `nimbusSpawn` refuses an argument cmd.exe would act on whenever the `aws`
 * found first on PATH is a batch file — a pip-installed v1.
 */
function pinPath(dir: () => string): void {
  let saved: string | undefined;
  beforeEach(() => {
    saved = process.env["PATH"];
    process.env["PATH"] = dir();
  });
  afterEach(() => {
    if (saved === undefined) {
      delete process.env["PATH"];
    } else {
      process.env["PATH"] = saved;
    }
  });
}

/** A fresh directory for a block's tests, holding `files`, removed after them. */
function tempDirectoryHolding(files: Record<string, string>): () => string {
  let dir = "";
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "nimbus-iac-path-"));
    for (const [name, content] of Object.entries(files)) {
      writeFileSync(join(dir, name), content);
    }
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  return () => dir;
}

describe("iac tools (gateway mode)", () => {
  let tools: CapturedTools;

  // An empty PATH: whether aws is a batch file on this machine is the Windows block's subject below.
  pinPath(tempDirectoryHolding({}));

  beforeEach(() => {
    setConnectorMode("gateway");
    tools = captureTools(registerIacTools);
  });

  it("registers exactly IAC_TOOL_NAMES, in order", () => {
    expect(tools.registrationOrder()).toEqual([...IAC_TOOL_NAMES]);
  });

  it("covers every registered tool in the cases below", () => {
    expect(CASES.map((c) => c.tool)).toEqual([...IAC_TOOL_NAMES]);
  });

  for (const { tool, args, argv } of CASES) {
    it(`${tool} runs exactly its CLI command and reports ok`, async () => {
      const stub = cli({ stdout: "" });
      expect(await tools.callJson(tool, args)).toEqual({ ok: true });
      expect(commandsRun(stub)).toEqual([[...argv]]);
    });

    it(`${tool} throws the CLI's exit code and stderr`, async () => {
      cli({ exitCode: 3, stderr: "state locked" });
      await expect(tools.call(tool, args)).rejects.toThrow(`${argv[0]} exited 3: state locked`);
    });
  }

  it("hands the CLI the operator's environment (TF_VAR_*, AWS_PROFILE, …)", async () => {
    const stub = cli({ stdout: "" });
    await withEnv({ TF_VAR_region: "eu-west-1" }, async () => {
      await tools.call("iac_terraform_plan", { workingDirectory: "infra/prod" });
    });
    expect(stub.calls[0]?.env["TF_VAR_region"]).toBe("eu-west-1");
  });

  it("refuses an empty working directory before running anything", async () => {
    const stub = cli({ stdout: "" });
    await expect(tools.call("iac_terraform_apply", { workingDirectory: "" })).rejects.toThrow(
      "Too small: expected string to have >=1 characters",
    );
    expect(stub.calls).toEqual([]);
  });

  it("refuses a CloudFormation deploy without a template body", async () => {
    const stub = cli({ stdout: "" });
    await expect(tools.call("iac_cloudformation_deploy", { stackName: "web" })).rejects.toThrow(
      /"templateBody"[\s\S]*expected string, received undefined/,
    );
    expect(stub.calls).toEqual([]);
  });

  // A working directory starting with "-" would reach terraform or pulumi as a flag, and a stack
  // name starting with file:// would make aws read that file as the value.
  const REFUSED: readonly (readonly [string, Record<string, unknown>, string])[] = [
    ["iac_terraform_plan", { workingDirectory: "-help" }, 'must not start with "-"'],
    ["iac_pulumi_preview", { workingDirectory: "--stack=prod" }, 'must not start with "-"'],
    [
      "iac_pulumi_up",
      { workingDirectory: "stacks/web\n--yes" },
      "must not contain control characters",
    ],
    [
      "iac_cloudformation_deploy",
      { stackName: "file:///etc/hosts", templateBody: "{}" },
      'must not start with "file://"',
    ],
    [
      "iac_cloudformation_deploy",
      { stackName: "web", templateBody: "" },
      "Too small: expected string to have >=1 characters",
    ],
    // `aws cloudformation deploy` takes no more than 51,200 bytes without an S3 bucket, and refuses
    // a larger template only after the prompt; so does the schema, before it. 25,601 "é" are
    // 25,601 characters, under the character bound, but 51,202 bytes as UTF-8.
    [
      "iac_cloudformation_deploy",
      { stackName: "web", templateBody: "é".repeat(25_601) },
      "must be at most 51200 bytes as UTF-8",
    ],
    [
      "iac_cloudformation_deploy",
      { stackName: "web", templateBody: "x".repeat(51_201) },
      "Too big: expected string to have <=51200 characters",
    ],
  ];

  /** The arguments for a test's title, a long string shortened to its start and length. */
  const titleOf = (args: Record<string, unknown>): string =>
    JSON.stringify(args, (_key, value: unknown) =>
      typeof value === "string" && value.length > 40
        ? `${value.slice(0, 12)}… (${String(value.length)} characters)`
        : value,
    );

  for (const [tool, args, refusal] of REFUSED) {
    it(`${tool} refuses ${titleOf(args)} before running anything`, async () => {
      const stub = cli({ stdout: "" });
      await expect(tools.call(tool, args)).rejects.toThrow(refusalSaying(refusal));
      expect(stub.calls).toEqual([]);
    });
  }

  it("hands the template to aws as a UTF-8 file, never as an argument", async () => {
    // A document, not a name: it spans lines, runs past 1024 characters, starts with the YAML
    // document marker and quotes a loading prefix, none of which an argument may do.
    const templateBody = `---\nAWSTemplateFormatVersion: "2010-09-09"\nDescription: "Árvore, not file://x, ${"x".repeat(1100)}"\nResources: {}\n`;
    const stub = cli({ stdout: "" });
    expect(
      await tools.callJson("iac_cloudformation_deploy", { stackName: "web", templateBody }),
    ).toEqual({ ok: true });
    expect(templatesSeen.map((t) => t.content)).toEqual([templateBody]);
    expect(stub.calls[0]?.command.some((arg) => arg.includes("AWSTemplateFormatVersion"))).toBe(
      false,
    );
    // Left to itself the CLI reads the file in the locale's encoding: cp1252 on many Windows
    // machines, where "Á" fails to decode. v2 reads the first variable, v1 the second.
    expect(stub.calls[0]?.env["AWS_CLI_FILE_ENCODING"]).toBe("UTF-8");
    expect(stub.calls[0]?.env["PYTHONUTF8"]).toBe("1");
  });

  it("deploys a template of exactly 51,200 bytes, the most the CLI takes without a bucket", async () => {
    const templateBody = `#${"é".repeat(25_599)}x`; // 1 + 51,198 + 1 bytes
    expect(new TextEncoder().encode(templateBody).length).toBe(51_200);
    cli({ stdout: "" });
    expect(
      await tools.callJson("iac_cloudformation_deploy", { stackName: "web", templateBody }),
    ).toEqual({ ok: true });
    expect(templatesSeen.map((t) => t.content)).toEqual([templateBody]);
  });

  it("removes the template file once the deploy has run, and when it has failed", async () => {
    // The file's directory is the tool's own, made for this one call, and goes with it.
    const directoryOfTheCall = (): string => {
      const path = templatesSeen[0]?.path;
      if (path === undefined) throw new Error("no template file reached the CLI");
      return dirname(path);
    };
    cli({ stdout: "" });
    await tools.call("iac_cloudformation_deploy", { stackName: "web", templateBody: "{}" });
    expect(existsSync(directoryOfTheCall())).toBe(false);

    cli({ exitCode: 255, stderr: "stack is in UPDATE_ROLLBACK_FAILED state" });
    await expect(
      tools.call("iac_cloudformation_deploy", { stackName: "web", templateBody: "{}" }),
    ).rejects.toThrow("aws exited 255");
    expect(existsSync(directoryOfTheCall())).toBe(false);
  });
});

describe.skipIf(process.platform !== "win32")(
  "iac when the aws first on PATH is a batch file (skipped off Windows: only there does cmd.exe parse a batch file's arguments again)",
  () => {
    let tools: CapturedTools;

    // The aws.cmd a pip-installed AWS CLI v1 puts on PATH. It never runs — the spawn is stubbed —
    // so what this shows is the check in front of it.
    pinPath(tempDirectoryHolding({ "aws.cmd": "@echo off\r\nexit /b 97\r\n" }));

    beforeEach(() => {
      setConnectorMode("gateway");
      tools = captureTools(registerIacTools);
    });

    it("deploys a template full of quotes, which cmd.exe never sees, and still refuses an argument", async () => {
      const stub = cli({ stdout: "" });
      // Quotes, an ampersand and a variable: each would be refused in an argument to a batch file.
      const templateBody = '{"Description":"a & b %PATH%","Resources":{}}';
      expect(
        await tools.callJson("iac_cloudformation_deploy", { stackName: "web", templateBody }),
      ).toEqual({ ok: true });
      expect(templatesSeen.map((t) => t.content)).toEqual([templateBody]);
      // The check is live for this aws: an argument holding one of those characters is refused, so
      // the deploy above passed because the template is not an argument.
      await expect(
        tools.call("iac_cloudformation_deploy", { stackName: "web&b", templateBody: "{}" }),
      ).rejects.toThrow('refused to run "aws": it may start a Windows batch file');
      expect(stub.calls).toHaveLength(1);
    });
  },
);

describe("iac write scope (standalone mode)", () => {
  let auditDir: string;
  let auditLog: string;

  beforeEach(() => {
    setConnectorMode("standalone");
    auditDir = mkdtempSync(join(tmpdir(), "nimbus-iac-audit-"));
    auditLog = join(auditDir, "audit.jsonl");
  });

  afterEach(() => {
    rmSync(auditDir, { recursive: true, force: true });
  });

  /** Register for a client that can (or cannot) prompt, with dir:infra/prod and stack:web in scope. */
  async function standalone(elicitation: boolean): Promise<CapturedTools> {
    let captured: CapturedTools | undefined;
    await withEnv(
      {
        NIMBUS_MCP_IAC_WRITE_SCOPE: "dir:infra/prod,stack:web",
        NIMBUS_MCP_AUDIT_LOG: auditLog,
        NIMBUS_MCP_WRITE_BUDGET: undefined,
      },
      () => {
        captured = captureStandaloneTools(registerIacTools, { elicitation }).tools;
      },
    );
    if (captured === undefined) throw new Error("registration did not run");
    return captured;
  }

  it("offers only the two read tools to a client that cannot prompt a human", async () => {
    expect((await standalone(false)).registrationOrder()).toEqual([
      "iac_terraform_plan",
      "iac_pulumi_preview",
    ]);
  });

  it("offers every tool, the four writes behind the gate, to a client that can", async () => {
    expect((await standalone(true)).names()).toEqual([...IAC_TOOL_NAMES].sort(byToolName));
  });

  it("checks terraform and pulumi writes against a dir: term", async () => {
    const tools = await standalone(true);
    const stub = cli({ stdout: "" });
    expect(await tools.callJson("iac_terraform_apply", { workingDirectory: "infra/prod" })).toEqual(
      { ok: true },
    );
    expect(await tools.callJson("iac_pulumi_up", { workingDirectory: "infra/dev" })).toEqual({
      ok: false,
      error: "out of scope: dir:infra/dev is not in NIMBUS_MCP_IAC_WRITE_SCOPE",
    });
    // Only the in-scope apply reached the CLI.
    expect(stub.calls.map((c) => c.command[0])).toEqual(["terraform"]);
  });

  it("checks a CloudFormation deploy against a stack: term, not a dir: one", async () => {
    const tools = await standalone(true);
    const stub = cli({ stdout: "" });
    expect(
      await tools.callJson("iac_cloudformation_deploy", { stackName: "web", templateBody: "{}" }),
    ).toEqual({ ok: true });
    // "infra/prod" IS in scope — but as a directory. A stack of that name is not.
    expect(
      await tools.callJson("iac_cloudformation_deploy", {
        stackName: "infra/prod",
        templateBody: "{}",
      }),
    ).toEqual({
      ok: false,
      error: "out of scope: stack:infra/prod is not in NIMBUS_MCP_IAC_WRITE_SCOPE",
    });
    expect(stub.calls).toHaveLength(1);
  });

  it("records the destroyed directory as the destroy's pre-state", async () => {
    const tools = await standalone(true);
    cli({ stdout: "" });
    await tools.call("iac_terraform_destroy", { workingDirectory: "infra/prod" });
    const entries = readFileSync(auditLog, "utf8")
      .trim()
      .split("\n")
      .map(
        (l) =>
          (JSON.parse(l) as { entry: { outcome: string; detail: Record<string, unknown> } }).entry,
      );
    const executed = entries.find((e) => e.outcome === "executed");
    expect(executed?.detail["preState"]).toEqual({ workingDirectory: "infra/prod" });
  });
});
