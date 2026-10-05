import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

/** Answer every CLI call with this reply, replacing any stub already installed. */
function cli(reply: { stdout?: string; stderr?: string; exitCode?: number }): SpawnStub {
  spawn?.restore();
  spawn = stubSpawn(reply);
  return spawn;
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
  {
    tool: "iac_terraform_plan",
    args: { workingDirectory: "infra/prod" },
    argv: ["terraform", "-chdir", "infra/prod", "plan", "-input=false"],
  },
  {
    tool: "iac_terraform_apply",
    args: { workingDirectory: "infra/prod" },
    argv: ["terraform", "-chdir", "infra/prod", "apply", "-auto-approve", "-input=false"],
  },
  {
    tool: "iac_terraform_destroy",
    args: { workingDirectory: "infra/prod" },
    argv: ["terraform", "-chdir", "infra/prod", "destroy", "-auto-approve", "-input=false"],
  },
  {
    tool: "iac_cloudformation_deploy",
    args: { stackName: "web", templateBody: '{"Resources":{}}' },
    argv: [
      "aws",
      "cloudformation",
      "deploy",
      "--stack-name",
      "web",
      "--template-body",
      '{"Resources":{}}',
      "--capabilities",
      "CAPABILITY_IAM",
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

describe("iac tools (gateway mode)", () => {
  let tools: CapturedTools;

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
      expect(stub.calls.map((c) => c.command)).toEqual([[...argv]]);
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
  // name or template body starting with file:// would make aws read that file as the value.
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
      { stackName: "web", templateBody: "file:///etc/passwd" },
      'must not start with "file://"',
    ],
    [
      "iac_cloudformation_deploy",
      { stackName: "web", templateBody: "--debug" },
      'must not start with "-"',
    ],
  ];

  for (const [tool, args, refusal] of REFUSED) {
    it(`${tool} refuses ${JSON.stringify(args)} before running anything`, async () => {
      const stub = cli({ stdout: "" });
      await expect(tools.call(tool, args)).rejects.toThrow(refusalSaying(refusal));
      expect(stub.calls).toEqual([]);
    });
  }

  it("still passes a template body that spans lines and runs past 1024 characters", async () => {
    // A template is a document, not a name: the argument rules about length and control
    // characters would make every real one impossible to pass.
    const templateBody = `AWSTemplateFormatVersion: "2010-09-09"\nDescription: ${"x".repeat(1100)}\nResources: {}\n`;
    const stub = cli({ stdout: "" });
    expect(
      await tools.callJson("iac_cloudformation_deploy", { stackName: "web", templateBody }),
    ).toEqual({ ok: true });
    expect(stub.calls[0]?.command[6]).toBe(templateBody);
  });
});

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
