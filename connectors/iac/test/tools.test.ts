import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  byToolName,
  type CapturedTools,
  captureStandaloneTools,
  captureTools,
  refusalSaying,
  type ScriptedReply,
  type SpawnStub,
  stubSpawnScript,
  withEnv,
} from "../../../scripts/connector-tool-harness.ts";
import { resetConnectorModeForTests, setConnectorMode } from "../../../shared/connector-mode.ts";
import { IAC_TOOL_NAMES, iacTimeHooks, registerIacTools } from "../src/tools.ts";

const sha = (s: string | Uint8Array): string => createHash("sha256").update(s).digest("hex");

let spawn: SpawnStub | undefined;
let planDir = "";
let scratchDir = "";
let workDir = "";
const savedEnv: Record<string, string | undefined> = {};
const ENV_KEYS = ["NIMBUS_IAC_PLAN_DIR", "NIMBUS_CONNECTOR_SCRATCH_DIR", "PATH"] as const;
const realHooks = { ...iacTimeHooks };

beforeEach(() => {
  resetConnectorModeForTests();
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  planDir = mkdtempSync(join(tmpdir(), "nimbus-iac-plans-"));
  scratchDir = mkdtempSync(join(tmpdir(), "nimbus-iac-scratch-"));
  workDir = mkdtempSync(join(tmpdir(), "nimbus-iac-work-"));
  process.env["NIMBUS_IAC_PLAN_DIR"] = planDir;
  process.env["NIMBUS_CONNECTOR_SCRATCH_DIR"] = scratchDir;
  // An empty PATH directory: whether aws is a batch file on this machine is not under test.
  process.env["PATH"] = workDir;
  // Time never really passes in a poll test.
  let clock = 0;
  iacTimeHooks.now = () => clock;
  iacTimeHooks.sleep = (ms) => {
    clock += ms;
    return Promise.resolve();
  };
});

afterEach(() => {
  spawn?.restore();
  spawn = undefined;
  iacTimeHooks.now = realHooks.now;
  iacTimeHooks.sleep = realHooks.sleep;
  for (const k of ENV_KEYS) {
    const v = savedEnv[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  for (const d of [planDir, scratchDir, workDir]) rmSync(d, { recursive: true, force: true });
  resetConnectorModeForTests();
});

function script(
  fn: (command: readonly string[], env: Record<string, string | undefined>) => ScriptedReply,
): SpawnStub {
  spawn?.restore();
  spawn = stubSpawnScript(fn);
  return spawn;
}

// ---------------------------------------------------------------------------
// Terraform

/** A terraform fake: `plan` writes the file `-out=` names and exits with `planExit`. */
function terraform(planExit: number, planBytes = "PLAN-BYTES"): SpawnStub {
  return script((cmd) => {
    const out = cmd.find((a) => a.startsWith("-out="));
    if (out !== undefined) writeFileSync(out.slice("-out=".length), planBytes);
    if (cmd.includes("plan")) {
      return { exitCode: planExit, stderr: planExit === 1 ? "Error: boom" : "" };
    }
    if (cmd.includes("show")) return { stdout: '{"format_version":"1.2"}' };
    return { stdout: "" };
  });
}

/** A plan file of known bytes, as a prepare would have left it. */
function savedPlan(bytes = "APPROVED-PLAN", name = "plan.tfplan"): { file: string; hash: string } {
  const dir = join(planDir, "p1");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, name);
  writeFileSync(file, bytes);
  return { file, hash: sha(bytes) };
}

describe("iac terraform (gateway mode)", () => {
  let tools: CapturedTools;
  beforeEach(() => {
    setConnectorMode("gateway");
    tools = captureTools(registerIacTools);
  });

  it("registers exactly IAC_TOOL_NAMES, in order", () => {
    expect(tools.registrationOrder()).toEqual([...IAC_TOOL_NAMES]);
  });

  it("plan runs the exact argv, in automation mode, and reports the saved plan", async () => {
    const stub = terraform(2);
    const r = (await tools.callJson("iac_terraform_plan", { workingDirectory: "infra/prod" })) as {
      planId: string;
      planFile: string;
      planSha256: string;
      hasChanges: boolean;
    };
    expect(r.hasChanges).toBe(true);
    expect(r.planId).toMatch(/^[0-9a-f]{32}$/);
    expect(r.planFile).toBe(join(planDir, r.planId, "plan.tfplan"));
    expect(r.planSha256).toBe(sha("PLAN-BYTES"));
    expect(stub.calls.map((c) => c.command)).toEqual([
      [
        "terraform",
        "-chdir=infra/prod",
        "plan",
        "-input=false",
        "-no-color",
        "-detailed-exitcode",
        "-lock-timeout=30s",
        `-out=${r.planFile}`,
      ],
    ]);
    expect(stub.calls[0]?.env["TF_IN_AUTOMATION"]).toBe("1");
    expect(stub.calls[0]?.env["TF_INPUT"]).toBe("0");
  });

  it("destroy plan adds -destroy right after plan", async () => {
    const stub = terraform(0);
    const r = (await tools.callJson("iac_terraform_destroy_plan", {
      workingDirectory: "infra/prod",
    })) as { hasChanges: boolean };
    expect(r.hasChanges).toBe(false);
    expect(stub.calls[0]?.command.slice(0, 5)).toEqual([
      "terraform",
      "-chdir=infra/prod",
      "plan",
      "-destroy",
      "-input=false",
    ]);
  });

  it("exit 1 throws the stderr and leaves no plan directory behind", async () => {
    terraform(1);
    await expect(
      tools.call("iac_terraform_plan", { workingDirectory: "infra/prod" }),
    ).rejects.toThrow("terraform exited 1: Error: boom");
    expect(readdirSync(planDir)).toEqual([]);
  });

  it("two plans get different plan ids and directories", async () => {
    terraform(2);
    const a = (await tools.callJson("iac_terraform_plan", { workingDirectory: "a" })) as {
      planId: string;
    };
    const b = (await tools.callJson("iac_terraform_plan", { workingDirectory: "a" })) as {
      planId: string;
    };
    expect(a.planId).not.toBe(b.planId);
    expect(readdirSync(planDir).sort()).toEqual([a.planId, b.planId].sort());
  });

  it("refuses a missing, relative or non-directory NIMBUS_IAC_PLAN_DIR before spawning", async () => {
    const stub = terraform(2);
    const notDir = join(workDir, "file");
    writeFileSync(notDir, "x");
    for (const value of [undefined, "relative/dir", notDir, join(workDir, "nope")]) {
      await withEnv({ NIMBUS_IAC_PLAN_DIR: value }, async () => {
        await expect(tools.call("iac_terraform_plan", { workingDirectory: "a" })).rejects.toThrow(
          /NIMBUS_IAC_PLAN_DIR/,
        );
      });
    }
    expect(stub.calls).toEqual([]);
  });

  it("refuses a symlinked NIMBUS_IAC_PLAN_DIR", async () => {
    const stub = terraform(2);
    const link = join(workDir, "link");
    try {
      symlinkSync(planDir, link, "junction");
    } catch {
      return; // cannot create links on this machine
    }
    await withEnv({ NIMBUS_IAC_PLAN_DIR: link }, async () => {
      await expect(tools.call("iac_terraform_plan", { workingDirectory: "a" })).rejects.toThrow(
        "must be a real directory",
      );
    });
    expect(stub.calls).toEqual([]);
  });

  it("show_json runs the exact argv and returns the JSON text", async () => {
    const { file } = savedPlan();
    const stub = terraform(0);
    expect(
      await tools.callJson("iac_terraform_show_json", { workingDirectory: "w", planFile: file }),
    ).toEqual({ planJson: '{"format_version":"1.2"}', planSha256: sha("APPROVED-PLAN") });
    expect(stub.calls[0]?.command).toEqual([
      "terraform",
      "-chdir=w",
      "show",
      "-json",
      "-no-color",
      realpathSync(file),
    ]);
    expect(stub.calls[0]?.env["TF_INPUT"]).toBe("0");
  });

  it("show_json refuses non-JSON, an oversize result and a failing exit", async () => {
    const { file } = savedPlan();
    script(() => ({ stdout: "not json" }));
    await expect(
      tools.call("iac_terraform_show_json", { workingDirectory: "w", planFile: file }),
    ).rejects.toThrow("did not print JSON");
    script(() => ({ stdout: `"${"x".repeat(4 * 1024 * 1024)}"` }));
    await expect(
      tools.call("iac_terraform_show_json", { workingDirectory: "w", planFile: file }),
    ).rejects.toThrow("plan JSON too large");
    script(() => ({ exitCode: 1, stderr: "no init" }));
    await expect(
      tools.call("iac_terraform_show_json", { workingDirectory: "w", planFile: file }),
    ).rejects.toThrow("terraform exited 1: no init");
  });

  for (const tool of ["iac_terraform_show_json", "iac_terraform_apply"] as const) {
    it(`${tool} refuses a relative, missing, symlinked or non-file plan file, spawning nothing`, async () => {
      const stub = terraform(0);
      const args = (planFile: string): Record<string, unknown> => ({
        workingDirectory: "w",
        planFile,
        planSha256: "a".repeat(64),
      });
      await expect(tools.call(tool, args("plan.tfplan"))).rejects.toThrow(
        "must be an absolute path",
      );
      await expect(tools.call(tool, args(join(planDir, "missing", "plan.tfplan")))).rejects.toThrow(
        "planFile does not exist",
      );
      const real = savedPlan().file;
      mkdirSync(join(planDir, "l"));
      const link = join(planDir, "l", "plan.tfplan");
      let linked = true;
      try {
        symlinkSync(real, link);
      } catch {
        linked = false;
      }
      if (linked) {
        await expect(tools.call(tool, args(link))).rejects.toThrow("not a link");
      }
      mkdirSync(join(planDir, "d", "plan.tfplan"), { recursive: true });
      await expect(tools.call(tool, args(join(planDir, "d", "plan.tfplan")))).rejects.toThrow(
        "regular file",
      );
      expect(stub.calls).toEqual([]);
    });
  }

  for (const tool of ["iac_terraform_show_json", "iac_terraform_apply"] as const) {
    it(`${tool} refuses a plan outside NIMBUS_IAC_PLAN_DIR: elsewhere, a sibling-prefix dir, a symlinked parent`, async () => {
      const stub = terraform(0);
      const args = (planFile: string): Record<string, unknown> => ({
        workingDirectory: "w",
        planFile,
        planSha256: sha("X"),
      });
      const outside = join(workDir, "plan.tfplan");
      writeFileSync(outside, "X");
      await expect(tools.call(tool, args(outside))).rejects.toThrow("must be inside");
      // A sibling whose name merely starts with the plan dir's.
      const evil = `${planDir}-evil`;
      mkdirSync(evil);
      try {
        writeFileSync(join(evil, "plan.tfplan"), "X");
        await expect(tools.call(tool, args(join(evil, "plan.tfplan")))).rejects.toThrow(
          "must be inside",
        );
      } finally {
        rmSync(evil, { recursive: true, force: true });
      }
      // A symlinked PARENT directory inside the plan dir that points outside.
      const target = mkdtempSync(join(tmpdir(), "nimbus-iac-target-"));
      try {
        writeFileSync(join(target, "plan.tfplan"), "X");
        let linked = true;
        try {
          symlinkSync(target, join(planDir, "parent"), "junction");
        } catch {
          linked = false;
        }
        if (linked) {
          await expect(
            tools.call(tool, args(join(planDir, "parent", "plan.tfplan"))),
          ).rejects.toThrow("must be inside");
        }
      } finally {
        rmSync(target, { recursive: true, force: true });
      }
      expect(stub.calls).toEqual([]);
    });

    it(`${tool} needs NIMBUS_IAC_PLAN_DIR and refuses device and network paths`, async () => {
      const { file, hash } = savedPlan();
      const stub = terraform(0);
      const args = (planFile: string): Record<string, unknown> => ({
        workingDirectory: "w",
        planFile,
        planSha256: hash,
      });
      await withEnv({ NIMBUS_IAC_PLAN_DIR: undefined }, async () => {
        await expect(tools.call(tool, args(file))).rejects.toThrow(/NIMBUS_IAC_PLAN_DIR/);
      });
      const bads = [
        String.raw`\?\C:\x\plan.tfplan`,
        String.raw`\.\C:\plan.tfplan`,
        String.raw`\host\share\plan.tfplan`,
      ];
      for (const bad of bads) {
        await expect(tools.call(tool, args(bad))).rejects.toThrow("device or network path");
      }
      expect(stub.calls).toEqual([]);
    });
  }

  it("apply takes only plan.tfplan and destroy only destroy.tfplan, in the handler", async () => {
    const stub = terraform(0);
    const plan = savedPlan("P", "plan.tfplan");
    const destroy = savedPlan("D", "destroy.tfplan");
    await expect(
      tools.call("iac_terraform_apply", {
        workingDirectory: "w",
        planFile: destroy.file,
        planSha256: destroy.hash,
      }),
    ).rejects.toThrow("must be named plan.tfplan");
    await expect(
      tools.call("iac_terraform_destroy", {
        workingDirectory: "w",
        planFile: plan.file,
        planSha256: plan.hash,
      }),
    ).rejects.toThrow("must be named destroy.tfplan");
    expect(stub.calls).toEqual([]);
  });

  it("show_json accepts either kind of plan", async () => {
    terraform(0);
    for (const name of ["plan.tfplan", "destroy.tfplan"]) {
      const { file } = savedPlan("B", name);
      expect(
        await tools.callJson("iac_terraform_show_json", { workingDirectory: "w", planFile: file }),
      ).toMatchObject({ planSha256: sha("B") });
    }
  });

  it("plan saves plan.tfplan and destroy_plan saves destroy.tfplan", async () => {
    terraform(2);
    const a = (await tools.callJson("iac_terraform_plan", { workingDirectory: "w" })) as {
      planFile: string;
    };
    const b = (await tools.callJson("iac_terraform_destroy_plan", { workingDirectory: "w" })) as {
      planFile: string;
    };
    expect(a.planFile.endsWith(`${"/"}plan.tfplan`) || a.planFile.endsWith("plan.tfplan")).toBe(
      true,
    );
    expect(b.planFile.endsWith("destroy.tfplan")).toBe(true);
  });

  it("refuses a flag-shaped plan file at the schema", async () => {
    const stub = terraform(0);
    await expect(
      tools.call("iac_terraform_show_json", { workingDirectory: "w", planFile: "-x" }),
    ).rejects.toThrow(refusalSaying('must not start with "-"'));
    expect(stub.calls).toEqual([]);
  });

  for (const [tool, name] of [
    ["iac_terraform_apply", "plan.tfplan"],
    ["iac_terraform_destroy", "destroy.tfplan"],
  ] as const) {
    it(`${tool} applies the SAME (real) plan file it hashed, with no -auto-approve and no -destroy, then removes it`, async () => {
      const { file, hash } = savedPlan("APPROVED-PLAN", name);
      const real = realpathSync(file);
      const stub = terraform(0);
      expect(
        await tools.callJson(tool, { workingDirectory: "w", planFile: file, planSha256: hash }),
      ).toEqual({ ok: true, status: "applied" });
      expect(stub.calls.map((c) => c.command)).toEqual([
        ["terraform", "-chdir=w", "apply", "-input=false", "-no-color", real],
      ]);
      expect(existsSync(file)).toBe(false);
      expect(stub.calls[0]?.env["TF_IN_AUTOMATION"]).toBe("1");
      expect(stub.calls[0]?.env["TF_INPUT"]).toBe("0");
    });

    it(`${tool} spawns nothing when the plan file is not the approved one`, async () => {
      const { file } = savedPlan("APPROVED-PLAN", name);
      const stub = terraform(0);
      await expect(
        tools.call(tool, { workingDirectory: "w", planFile: file, planSha256: "0".repeat(64) }),
      ).rejects.toThrow("plan file does not match the approved hash");
      expect(stub.calls).toEqual([]);
    });

    it(`${tool} throws terraform's exit code and stderr, keeping the plan`, async () => {
      const { file, hash } = savedPlan("APPROVED-PLAN", name);
      script(() => ({ exitCode: 1, stderr: "Saved plan is stale" }));
      await expect(
        tools.call(tool, { workingDirectory: "w", planFile: file, planSha256: hash }),
      ).rejects.toThrow("terraform exited 1: Saved plan is stale");
    });
  }

  it("refuses an uppercase or short hash at the schema", async () => {
    const { file } = savedPlan();
    for (const planSha256 of ["A".repeat(64), "a".repeat(63)]) {
      await expect(
        tools.call("iac_terraform_apply", { workingDirectory: "w", planFile: file, planSha256 }),
      ).rejects.toThrow();
    }
  });
});

// ---------------------------------------------------------------------------
// Pulumi

describe("iac pulumi", () => {
  it("preview is unchanged", async () => {
    setConnectorMode("gateway");
    const tools = captureTools(registerIacTools);
    const stub = script(() => ({ stdout: "" }));
    expect(await tools.callJson("iac_pulumi_preview", { workingDirectory: "stacks/web" })).toEqual({
      ok: true,
    });
    expect(stub.calls.map((c) => c.command)).toEqual([
      ["pulumi", "preview", "--cwd", "stacks/web", "--non-interactive"],
    ]);
  });

  it("up always throws and spawns nothing, in gateway mode", async () => {
    setConnectorMode("gateway");
    const tools = captureTools(registerIacTools);
    const stub = script(() => ({ stdout: "" }));
    await expect(tools.call("iac_pulumi_up", { workingDirectory: "stacks/web" })).rejects.toThrow(
      "iac_pulumi_up is refused: Pulumi saved update plans are documented as experimental",
    );
    expect(stub.calls).toEqual([]);
  });

  it("up is refused standalone without a prompt, even in scope", async () => {
    setConnectorMode("standalone");
    const stub = script(() => ({ stdout: "" }));
    const cap = await withEnv(
      { NIMBUS_MCP_IAC_WRITE_SCOPE: "dir:stacks/web", NIMBUS_MCP_AUDIT_LOG: undefined },
      () => captureStandaloneTools(registerIacTools, { elicitation: true }),
    );
    const answer = (await cap.tools.callJson("iac_pulumi_up", {
      workingDirectory: "stacks/web",
    })) as { ok: boolean; error: string };
    expect(answer.ok).toBe(false);
    expect(answer.error).toContain("no plan-bound apply exists");
    expect(cap.prompts).toEqual([]);
    expect(stub.calls).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// CloudFormation

const ACCOUNT = "123456789012";
const UUID = "11111111-2222-3333-4444-555555555555";
const arnOf = (name: string): string =>
  `arn:aws:cloudformation:us-east-1:${ACCOUNT}:changeSet/${name}/${UUID}`;
const TEMPLATE = '{"Resources":{}}';
const goodName = (tpl = TEMPLATE): string => `nimbus-${sha(tpl)}-0123456789ab`;

type Reply = Record<string, unknown>;

/** Mutable state of a fake CloudFormation. */
type World = {
  /** undefined = the stack does not exist. */
  stackStatus?: string;
  /** describe-change-set answers, in order; the last repeats. */
  csReplies: Reply[];
  /** answers keyed by `--next-token`. */
  pages: Record<string, Reply>;
  summaries: unknown[];
  describeChangeSetMissing?: boolean;
  templatesSeen: string[];
};

const COMPLETE: Reply = {
  Status: "CREATE_COMPLETE",
  ExecutionStatus: "AVAILABLE",
  StackName: "web",
  Changes: [],
};

function newWorld(over: Partial<World> = {}): World {
  return { csReplies: [COMPLETE], pages: {}, summaries: [], templatesSeen: [], ...over };
}

function aws(w: World): SpawnStub {
  let polls = 0;
  return script((cmd) => {
    const flag = (f: string): string | undefined =>
      cmd.includes(f) ? cmd[cmd.indexOf(f) + 1] : undefined;
    switch (cmd[2]) {
      case "describe-stacks":
        return w.stackStatus === undefined
          ? { exitCode: 254, stderr: `Stack with id ${flag("--stack-name")} does not exist` }
          : {
              stdout: JSON.stringify({
                Stacks: [{ StackStatus: w.stackStatus, LastUpdatedTime: "2026-01-01T00:00:00Z" }],
              }),
            };
      case "create-change-set": {
        const tb = flag("--template-body") ?? "";
        w.templatesSeen.push(readFileSync(tb.replace("file://", ""), "utf8"));
        return {
          stdout: JSON.stringify({
            Id: arnOf(flag("--change-set-name") ?? ""),
            StackId: `arn:aws:cloudformation:us-east-1:${ACCOUNT}:stack/web/${UUID}`,
          }),
        };
      }
      case "describe-change-set": {
        if (w.describeChangeSetMissing === true) {
          return { exitCode: 254, stderr: "ChangeSetNotFound: not found" };
        }
        const tok = flag("--next-token");
        if (tok !== undefined) return { stdout: JSON.stringify(w.pages[tok] ?? {}) };
        const reply = w.csReplies[Math.min(polls, w.csReplies.length - 1)];
        polls += 1;
        return { stdout: JSON.stringify(reply) };
      }
      case "list-change-sets":
        return { stdout: JSON.stringify({ Summaries: w.summaries }) };
      default:
        return { stdout: "" };
    }
  });
}

const subs = (stub: SpawnStub): string[] => stub.calls.map((c) => c.command[2] ?? "");

const rowOf = (id: string, extra: Reply = {}): Reply => ({
  ResourceChange: { Action: "Add", LogicalResourceId: id, ResourceType: "T", ...extra },
});

describe("iac cloudformation (gateway mode)", () => {
  let tools: CapturedTools;
  beforeEach(() => {
    setConnectorMode("gateway");
    tools = captureTools(registerIacTools);
  });

  const create = (extra: Reply = {}): Promise<unknown> =>
    tools.callJson("iac_cloudformation_changeset_create", {
      stackName: "web",
      templateBody: TEMPLATE,
      ...extra,
    });

  for (const [label, status, type] of [
    ["a missing stack", undefined, "CREATE"],
    ["REVIEW_IN_PROGRESS", "REVIEW_IN_PROGRESS", "CREATE"],
    ["DELETE_COMPLETE", "DELETE_COMPLETE", "CREATE"],
    ["CREATE_COMPLETE", "CREATE_COMPLETE", "UPDATE"],
  ] as const) {
    it(`create chooses ${type} for ${label}`, async () => {
      const stub = aws(newWorld(status === undefined ? {} : { stackStatus: status }));
      const r = (await create()) as { changeSetType: string };
      expect(r.changeSetType).toBe(type);
      const argv = stub.calls[1]?.command ?? [];
      expect(argv[argv.indexOf("--change-set-type") + 1]).toBe(type);
    });
  }

  it("create runs the exact commands, hands the template as file://, and binds the name to its hash", async () => {
    const w = newWorld({
      stackStatus: "CREATE_COMPLETE",
      csReplies: [
        { Status: "CREATE_PENDING" },
        {
          Status: "CREATE_COMPLETE",
          Changes: [
            rowOf("Bucket", { ResourceType: "AWS::S3::Bucket", Replacement: "False", Scope: [] }),
          ],
        },
      ],
    });
    const stub = aws(w);
    const r = (await create({ capabilities: ["CAPABILITY_IAM", "CAPABILITY_NAMED_IAM"] })) as {
      changeSetId: string;
      changeSetName: string;
      templateSha256: string;
      capabilities: string[];
      changes: unknown[];
    };
    expect(r.templateSha256).toBe(sha(TEMPLATE));
    expect(r.changeSetName).toMatch(new RegExp(`^nimbus-${sha(TEMPLATE)}-[0-9a-f]{12}$`));
    expect(r.changeSetId).toBe(arnOf(r.changeSetName));
    expect(r.capabilities).toEqual(["CAPABILITY_IAM", "CAPABILITY_NAMED_IAM"]);
    expect(r.changes).toEqual([
      {
        action: "Add",
        logicalId: "Bucket",
        resourceType: "AWS::S3::Bucket",
        replacement: "False",
        scope: [],
      },
    ]);
    const cmds = stub.calls.map((c) => c.command);
    expect(cmds[0]).toEqual([
      "aws",
      "cloudformation",
      "describe-stacks",
      "--stack-name",
      "web",
      "--output",
      "json",
    ]);
    const made = cmds[1] ?? [];
    expect(made.slice(0, 9)).toEqual([
      "aws",
      "cloudformation",
      "create-change-set",
      "--stack-name",
      "web",
      "--change-set-name",
      r.changeSetName,
      "--change-set-type",
      "UPDATE",
    ]);
    expect(made[9]).toBe("--template-body");
    expect(made[10]?.startsWith("file://")).toBe(true);
    expect(made.slice(11)).toEqual([
      "--capabilities",
      "CAPABILITY_IAM",
      "CAPABILITY_NAMED_IAM",
      "--output",
      "json",
    ]);
    expect(cmds[2]).toEqual([
      "aws",
      "cloudformation",
      "describe-change-set",
      "--change-set-name",
      r.changeSetId,
      "--output",
      "json",
    ]);
    // Polled twice (pending, then complete); the UTF-8 env is set on every aws call.
    expect(subs(stub)).toEqual([
      "describe-stacks",
      "create-change-set",
      "describe-change-set",
      "describe-change-set",
    ]);
    for (const c of stub.calls) {
      expect(c.env["AWS_CLI_FILE_ENCODING"]).toBe("UTF-8");
      expect(c.env["PYTHONUTF8"]).toBe("1");
    }
    expect(w.templatesSeen).toEqual([TEMPLATE]);
    expect(readdirSync(scratchDir)).toEqual([]);
  });

  it("create hands a non-ASCII, YAML-marker template over unchanged", async () => {
    const tpl = `---\nDescription: "Árvore ${"x".repeat(1100)}"\nResources: {}\n`;
    const w = newWorld();
    aws(w);
    await tools.call("iac_cloudformation_changeset_create", {
      stackName: "web",
      templateBody: tpl,
    });
    expect(w.templatesSeen).toEqual([tpl]);
  });

  it("create cleans up (delete-change-set, then a stack check) when the change set FAILED, and throws the reason", async () => {
    const w = newWorld({
      csReplies: [
        { Status: "FAILED", StatusReason: "The submitted information didn't contain changes" },
      ],
    });
    const stub = aws(w);
    await expect(create()).rejects.toThrow(
      "change set FAILED: The submitted information didn't contain changes",
    );
    expect(subs(stub)).toEqual([
      "describe-stacks",
      "create-change-set",
      "describe-change-set",
      "delete-change-set",
      "describe-stacks",
    ]);
    expect(stub.calls[3]?.command).toEqual([
      "aws",
      "cloudformation",
      "delete-change-set",
      "--change-set-name",
      arnOf(
        (stub.calls[1]?.command ?? [])[
          (stub.calls[1]?.command ?? []).indexOf("--change-set-name") + 1
        ] ?? "",
      ),
    ]);
  });

  it("cleanup deletes the stack only when it is REVIEW_IN_PROGRESS with no change sets", async () => {
    for (const [status, summaries, deleted] of [
      ["REVIEW_IN_PROGRESS", [], true],
      ["REVIEW_IN_PROGRESS", [{ ChangeSetName: "other" }], false],
      ["CREATE_COMPLETE", [], false],
    ] as const) {
      const stub = aws(
        newWorld({
          stackStatus: status,
          summaries: [...summaries],
          csReplies: [{ Status: "FAILED", StatusReason: "x" }],
        }),
      );
      await expect(create()).rejects.toThrow("change set FAILED");
      expect(subs(stub).includes("delete-stack")).toBe(deleted);
      if (deleted) {
        expect(stub.calls.at(-1)?.command).toEqual([
          "aws",
          "cloudformation",
          "delete-stack",
          "--stack-name",
          "web",
        ]);
      }
    }
  });

  it("create cleans up and throws when the poll deadline passes", async () => {
    const stub = aws(newWorld({ csReplies: [{ Status: "CREATE_IN_PROGRESS" }] }));
    await expect(create()).rejects.toThrow("not ready within 120 seconds");
    expect(subs(stub)).toContain("delete-change-set");
  });

  it("create follows NextToken pages by --next-token", async () => {
    const stub = aws(
      newWorld({
        csReplies: [{ Status: "CREATE_COMPLETE", Changes: [rowOf("A")], NextToken: "t1" }],
        pages: {
          t1: { Changes: [rowOf("B")], NextToken: "t2" },
          t2: { Changes: [rowOf("C")] },
        },
      }),
    );
    const r = (await create()) as { changes: { logicalId: string }[] };
    expect(r.changes.map((c) => c.logicalId)).toEqual(["A", "B", "C"]);
    const tokens = stub.calls
      .filter((c) => c.command.includes("--next-token"))
      .map((c) => c.command[c.command.indexOf("--next-token") + 1]);
    expect(tokens).toEqual(["t1", "t2"]);
  });

  it("create refuses more than 500 changes, after cleanup", async () => {
    const changes = Array.from({ length: 501 }, (_, i) => rowOf(`R${String(i)}`));
    const stub = aws(newWorld({ csReplies: [{ Status: "CREATE_COMPLETE", Changes: changes }] }));
    await expect(create()).rejects.toThrow("change set too large");
    expect(subs(stub)).toContain("delete-change-set");
  });

  it("create refuses a reply over 256 KiB, after cleanup", async () => {
    const changes = Array.from({ length: 400 }, (_, i) =>
      rowOf(`R${String(i)}`, { PhysicalResourceId: "p".repeat(1000) }),
    );
    const stub = aws(newWorld({ csReplies: [{ Status: "CREATE_COMPLETE", Changes: changes }] }));
    await expect(create()).rejects.toThrow("change set too large");
    expect(subs(stub)).toContain("delete-change-set");
  });

  it("create refuses a repeated capability and bad input before spawning", async () => {
    const stub = aws(newWorld());
    await expect(create({ capabilities: ["CAPABILITY_IAM", "CAPABILITY_IAM"] })).rejects.toThrow(
      "capabilities must not repeat a value",
    );
    await expect(create({ capabilities: ["CAPABILITY_ADMIN"] })).rejects.toThrow();
    await expect(
      tools.call("iac_cloudformation_changeset_create", {
        stackName: "web",
        templateBody: "é".repeat(25_601),
      }),
    ).rejects.toThrow("must be at most 51200 bytes as UTF-8");
    await expect(
      tools.call("iac_cloudformation_changeset_create", {
        stackName: "web",
        templateBody: "x".repeat(51_201),
      }),
    ).rejects.toThrow("Too big: expected string to have <=51200 characters");
    await expect(
      tools.call("iac_cloudformation_changeset_create", {
        stackName: "file:///etc/hosts",
        templateBody: "{}",
      }),
    ).rejects.toThrow(refusalSaying('must not start with "file://"'));
    expect(stub.calls).toEqual([]);
  });

  it("create accepts a template of exactly 51,200 bytes", async () => {
    const tpl = `#${"é".repeat(25_599)}x`;
    expect(new TextEncoder().encode(tpl)).toHaveLength(51_200);
    const w = newWorld();
    aws(w);
    await tools.call("iac_cloudformation_changeset_create", {
      stackName: "web",
      templateBody: tpl,
    });
    expect(w.templatesSeen).toEqual([tpl]);
  });

  it("create removes its scratch directory when the CLI fails", async () => {
    script((cmd) =>
      cmd[2] === "create-change-set"
        ? { exitCode: 255, stderr: "AccessDenied" }
        : { exitCode: 254, stderr: "does not exist" },
    );
    await expect(create()).rejects.toThrow("aws exited 255: AccessDenied");
    expect(readdirSync(scratchDir)).toEqual([]);
  });

  describe("deploy", () => {
    const deploy = (over: Reply = {}): Promise<unknown> =>
      tools.callJson("iac_cloudformation_deploy", {
        stackName: "web",
        templateBody: TEMPLATE,
        changeSetId: arnOf(goodName()),
        ...over,
      });
    const reply = (over: Reply): Partial<World> => ({ csReplies: [{ ...COMPLETE, ...over }] });

    it("executes the change set only after every check, and says 'execution started'", async () => {
      const stub = aws(newWorld(reply({ StackId: "sid", Capabilities: ["CAPABILITY_IAM"] })));
      expect(await deploy({ capabilities: ["CAPABILITY_IAM"] })).toEqual({
        ok: true,
        status: "execution started",
        changeSetId: arnOf(goodName()),
        stackId: "sid",
      });
      expect(stub.calls.map((c) => c.command)).toEqual([
        [
          "aws",
          "cloudformation",
          "describe-change-set",
          "--change-set-name",
          arnOf(goodName()),
          "--output",
          "json",
        ],
        ["aws", "cloudformation", "execute-change-set", "--change-set-name", arnOf(goodName())],
      ]);
      expect(JSON.stringify(stub.calls)).not.toContain('CAPABILITY_IAM"]');
      expect(stub.calls.some((c) => c.command.includes("--capabilities"))).toBe(false);
    });

    it("treats an absent Capabilities as empty", async () => {
      aws(newWorld());
      expect(await deploy()).toMatchObject({ ok: true });
    });

    const refusals: [string, Reply, Partial<World>, string][] = [
      [
        "a name bound to another template",
        { changeSetId: arnOf(goodName('{"Resources":{"A":{}}}')) },
        {},
        "not made for this template",
      ],
      [
        "a name that is not this connector's",
        { changeSetId: arnOf("manual-change-set") },
        {},
        "not made for this template",
      ],
      ["a different stack", {}, reply({ StackName: "other" }), "different stack"],
      ["an OBSOLETE change set", {}, reply({ ExecutionStatus: "OBSOLETE" }), "OBSOLETE"],
      [
        "an EXECUTE_COMPLETE change set",
        {},
        reply({ ExecutionStatus: "EXECUTE_COMPLETE" }),
        "EXECUTE_COMPLETE",
      ],
      [
        "an EXECUTE_IN_PROGRESS change set",
        {},
        reply({ ExecutionStatus: "EXECUTE_IN_PROGRESS" }),
        "EXECUTE_IN_PROGRESS",
      ],
      ["a FAILED change set", {}, reply({ Status: "FAILED" }), "not CREATE_COMPLETE"],
      [
        "capabilities the change set lacks",
        { capabilities: ["CAPABILITY_IAM"] },
        {},
        "capabilities do not match",
      ],
      [
        "a change set with more capabilities than approved",
        {},
        reply({ Capabilities: ["CAPABILITY_IAM"] }),
        "capabilities do not match",
      ],
      [
        "a repeated capability",
        { capabilities: ["CAPABILITY_IAM", "CAPABILITY_IAM"] },
        {},
        "must not repeat",
      ],
    ];
    for (const [label, args, over, message] of refusals) {
      it(`does not execute ${label}`, async () => {
        const stub = aws(newWorld(over));
        await expect(deploy(args)).rejects.toThrow(message);
        expect(subs(stub)).not.toContain("execute-change-set");
      });
    }

    it("refuses a template over 51,200 bytes with no spawn", async () => {
      const stub = aws(newWorld());
      await expect(deploy({ templateBody: "é".repeat(25_601) })).rejects.toThrow(
        "51200 bytes as UTF-8",
      );
      expect(stub.calls).toEqual([]);
    });

    it("refuses a malformed change set id at the schema", async () => {
      const stub = aws(newWorld());
      for (const changeSetId of [
        "file:///etc/hosts",
        "-x",
        "nimbus-name",
        "arn:aws:cloudformation:us-east-1:1:changeSet/a/b",
      ]) {
        await expect(deploy({ changeSetId })).rejects.toThrow();
      }
      expect(stub.calls).toEqual([]);
    });
  });

  describe("discard", () => {
    const discard = (over: Reply = {}): Promise<unknown> =>
      tools.callJson("iac_cloudformation_changeset_discard", {
        stackName: "web",
        changeSetId: arnOf(goodName()),
        ...over,
      });

    it("deletes the change set and the empty shell", async () => {
      const stub = aws(newWorld({ stackStatus: "REVIEW_IN_PROGRESS" }));
      expect(await discard()).toEqual({ ok: true, changeSetDeleted: true, stackDeleted: true });
      expect(subs(stub)).toEqual([
        "describe-change-set",
        "delete-change-set",
        "describe-stacks",
        "list-change-sets",
        "delete-stack",
      ]);
    });

    it("does not touch the stack at all when the change set is not found", async () => {
      const stub = aws(
        newWorld({ describeChangeSetMissing: true, stackStatus: "REVIEW_IN_PROGRESS" }),
      );
      expect(await discard()).toEqual({ ok: true, changeSetDeleted: false, stackDeleted: false });
      expect(subs(stub)).toEqual(["describe-change-set"]);
    });

    it("skips the delete for a change set that is already gone", async () => {
      const stub = aws(newWorld({ describeChangeSetMissing: true }));
      expect(await discard()).toEqual({ ok: true, changeSetDeleted: false, stackDeleted: false });
      expect(subs(stub)).not.toContain("delete-change-set");
    });

    it("refuses a change set of another stack, and a name that is not this connector's", async () => {
      const stub = aws(newWorld({ csReplies: [{ ...COMPLETE, StackName: "other" }] }));
      await expect(discard()).rejects.toThrow("different stack");
      expect(subs(stub)).not.toContain("delete-change-set");
      const stub2 = aws(newWorld());
      await expect(discard({ changeSetId: arnOf("manual") })).rejects.toThrow("nimbus-");
      expect(stub2.calls).toEqual([]);
    });
  });

  it("stack_get reports a missing stack and a present one", async () => {
    const w = newWorld();
    aws(w);
    expect(await tools.callJson("iac_cloudformation_stack_get", { stackName: "web" })).toEqual({
      exists: false,
    });
    w.stackStatus = "UPDATE_COMPLETE";
    expect(await tools.callJson("iac_cloudformation_stack_get", { stackName: "web" })).toEqual({
      exists: true,
      status: "UPDATE_COMPLETE",
      statusReason: null,
      lastUpdatedTime: "2026-01-01T00:00:00Z",
    });
  });

  it("stack_get throws any other describe-stacks failure", async () => {
    script(() => ({ exitCode: 255, stderr: "AccessDenied" }));
    await expect(tools.call("iac_cloudformation_stack_get", { stackName: "web" })).rejects.toThrow(
      "aws exited 255",
    );
  });
});

// ---------------------------------------------------------------------------
// Standalone consent kit

describe("iac standalone mode", () => {
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

  function standalone(elicitation: boolean): ReturnType<typeof captureStandaloneTools> {
    return withEnvSync(
      {
        NIMBUS_MCP_IAC_WRITE_SCOPE: "dir:infra/prod,stack:web",
        NIMBUS_MCP_AUDIT_LOG: auditLog,
        NIMBUS_MCP_WRITE_BUDGET: undefined,
      },
      () => captureStandaloneTools(registerIacTools, { elicitation }),
    );
  }

  type Entry = { tool: string; outcome: string; detail: Record<string, unknown> };
  const entries = (): Entry[] =>
    readFileSync(auditLog, "utf8")
      .trim()
      .split("\n")
      .map((l) => (JSON.parse(l) as { entry: Entry }).entry);

  it("offers the reads and the prepare tools to a client that cannot prompt, the writes only to one that can", () => {
    expect(standalone(false).tools.names()).toEqual(
      [
        "iac_terraform_plan",
        "iac_terraform_destroy_plan",
        "iac_terraform_show_json",
        "iac_cloudformation_changeset_create",
        "iac_cloudformation_stack_get",
        "iac_pulumi_preview",
      ].sort(byToolName),
    );
    expect(standalone(true).tools.names()).toEqual([...IAC_TOOL_NAMES].sort(byToolName));
  });

  it("refuses a prepare tool out of scope, with no spawn and no prompt", async () => {
    const cap = standalone(true);
    const stub = terraform(2);
    expect(
      await cap.tools.callJson("iac_terraform_plan", { workingDirectory: "infra/dev" }),
    ).toEqual({
      ok: false,
      error: "out of scope: dir:infra/dev is not in NIMBUS_MCP_IAC_WRITE_SCOPE",
    });
    expect(stub.calls).toEqual([]);
    expect(cap.prompts).toEqual([]);
  });

  it("runs a prepare tool in scope, audits it as prepared and never prompts", async () => {
    const cap = standalone(true);
    terraform(2);
    const r = (await cap.tools.callJson("iac_terraform_plan", {
      workingDirectory: "infra/prod",
    })) as { hasChanges: boolean };
    expect(r.hasChanges).toBe(true);
    expect(cap.prompts).toEqual([]);
    expect(entries().map((e) => [e.tool, e.outcome])).toEqual([["iac_terraform_plan", "prepared"]]);
  });

  it("checks a CloudFormation prepare against a stack: term, not a dir: one", async () => {
    const cap = standalone(true);
    const stub = aws(newWorld());
    expect(
      await cap.tools.callJson("iac_cloudformation_changeset_create", {
        stackName: "infra/prod",
        templateBody: "{}",
      }),
    ).toEqual({
      ok: false,
      error: "out of scope: stack:infra/prod is not in NIMBUS_MCP_IAC_WRITE_SCOPE",
    });
    expect(stub.calls).toEqual([]);
  });

  it("prompts for an apply and records its identifying parameters as the pre-state", async () => {
    const cap = standalone(true);
    const { file, hash } = savedPlan();
    terraform(0);
    expect(
      await cap.tools.callJson("iac_terraform_apply", {
        workingDirectory: "infra/prod",
        planFile: file,
        planSha256: hash,
      }),
    ).toEqual({ ok: true, status: "applied" });
    expect(cap.prompts).toHaveLength(1);
    expect(entries().find((e) => e.outcome === "executed")?.detail["preState"]).toEqual({
      workingDirectory: "infra/prod",
      planFile: file,
      planSha256: hash,
    });
  });

  it("refuses a relative plan file before scope, budget or prompt", async () => {
    const cap = standalone(true);
    const stub = terraform(0);
    expect(
      await cap.tools.callJson("iac_terraform_destroy", {
        workingDirectory: "infra/prod",
        planFile: "rel.tfplan",
        planSha256: "a".repeat(64),
      }),
    ).toEqual({ ok: false, error: "planFile must be an absolute path" });
    expect(cap.prompts).toEqual([]);
    expect(stub.calls).toEqual([]);
  });

  it("refuses a change set built for another template before any prompt", async () => {
    const cap = standalone(true);
    const stub = aws(newWorld());
    const answer = (await cap.tools.callJson("iac_cloudformation_deploy", {
      stackName: "web",
      templateBody: TEMPLATE,
      changeSetId: arnOf(`nimbus-${"0".repeat(64)}-0123456789ab`),
    })) as { error: string };
    expect(answer.error).toContain("not made for this template");
    expect(cap.prompts).toEqual([]);
    expect(stub.calls).toEqual([]);
  });

  it("records the stack's state as a deploy's pre-state", async () => {
    const cap = standalone(true);
    aws(newWorld({ stackStatus: "UPDATE_COMPLETE" }));
    await cap.tools.call("iac_cloudformation_deploy", {
      stackName: "web",
      templateBody: TEMPLATE,
      changeSetId: arnOf(goodName()),
    });
    expect(entries().find((e) => e.outcome === "executed")?.detail["preState"]).toEqual({
      exists: true,
      stackStatus: "UPDATE_COMPLETE",
      lastUpdatedTime: "2026-01-01T00:00:00Z",
    });
  });

  it("records the change set's state as a discard's pre-state", async () => {
    const cap = standalone(true);
    aws(newWorld());
    await cap.tools.call("iac_cloudformation_changeset_discard", {
      stackName: "web",
      changeSetId: arnOf(goodName()),
    });
    expect(entries().find((e) => e.outcome === "executed")?.detail["preState"]).toEqual({
      exists: true,
      status: "CREATE_COMPLETE",
      executionStatus: "AVAILABLE",
    });
  });
});

/** `withEnv` for a synchronous body: the kit reads its env while registering. */
function withEnvSync<T>(env: Record<string, string | undefined>, fn: () => T): T {
  const saved = new Map<string, string | undefined>();
  for (const [k, v] of Object.entries(env)) {
    saved.set(k, process.env[k]);
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}
