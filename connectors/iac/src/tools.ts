import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { awsCliArg, cliArg } from "../../../shared/cli-json-kit.ts";
import type { ConsentServer } from "../../../shared/consent-kit.ts";
import { createWriteToolRegistrar } from "../../../shared/consent-kit.ts";
import {
  createRegisterSimpleTool,
  createZodToolRegistrar,
  mcpJsonResult as jsonResult,
} from "../../../shared/mcp-tool-kit.ts";
import { runCliOkThrowing } from "../../../shared/run-cli-json.ts";

/**
 * The most a template may be when it is deployed without an S3 bucket, which this tool does not
 * take: `aws cloudformation deploy` refuses a larger one itself, and only after the prompt.
 */
const TEMPLATE_MAX_BYTES = 51_200;

/**
 * A CloudFormation template. It reaches the AWS CLI as a file, never as an argument (see
 * {@link withTemplateFile}), so none of the argument rules apply to it: a YAML template may well
 * start with `---`. Its size is refused here, in the schema, because no consent can lift it: a
 * larger template would be put to the human, spend a unit of write budget, and then fail. The
 * character bound is the one a client is shown; no string over it can be within the byte bound.
 */
const templateDocument = z
  .string()
  .min(1)
  .max(TEMPLATE_MAX_BYTES)
  .refine((t) => new TextEncoder().encode(t).length <= TEMPLATE_MAX_BYTES, {
    message: `must be at most ${String(TEMPLATE_MAX_BYTES)} bytes as UTF-8, the most aws cloudformation deploy takes without an S3 bucket`,
  });

/**
 * Run `body` with `template` written to a file of its own, removed afterwards however `body` ends.
 *
 * `aws cloudformation deploy` takes a template only as `--template-file`, and passing one as an
 * argument would not work anyway: a template can run past the 32,767 characters a Windows command
 * line holds, and an `aws` that is a batch file, as a pip-installed v1 is, has cmd.exe parse every
 * quote in it.
 */
async function withTemplateFile<T>(
  template: string,
  body: (path: string) => Promise<T>,
): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "nimbus-cfn-"));
  try {
    const path = join(dir, "template");
    await writeFile(path, template, { encoding: "utf8", mode: 0o600, flag: "wx" });
    return await body(path);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Tool names exposed by this connector — for contract/introspection tests. */
export const IAC_TOOL_NAMES = [
  "iac_terraform_plan",
  "iac_terraform_apply",
  "iac_terraform_destroy",
  "iac_cloudformation_deploy",
  "iac_pulumi_preview",
  "iac_pulumi_up",
] as const;

export function registerIacTools(
  server: ConsentServer & { tool: (...args: never) => unknown },
): void {
  const reg = createZodToolRegistrar(createRegisterSimpleTool(server));

  /**
   * Every MUTATING iac tool goes through here. Outside the gateway this adds the
   * consent gate, the write-scope allow-list, the mutation budget and the audit record; inside
   * the gateway it is a pass-through, because executor.ts (I2) is the gate there.
   */
  const registerWriteTool = createWriteToolRegistrar(server, {
    connector: "iac",
    scopeEnv: "NIMBUS_MCP_IAC_WRITE_SCOPE",
    scopeKinds: ["dir", "stack"],
  });

  const processEnv = process.env as Record<string, string | undefined>;

  reg(
    "iac_terraform_plan",
    "Run terraform plan in a directory.",
    z.object({ workingDirectory: cliArg }),
    async (p) => {
      await runCliOkThrowing(
        ["terraform", `-chdir=${p.workingDirectory}`, "plan", "-input=false"],
        {
          ...processEnv,
        },
      );
      return jsonResult({ ok: true });
    },
  );

  registerWriteTool(
    "iac_terraform_apply",
    {
      mutates: "iac.terraform.apply",
      recoverable: true,
      scopeTargetOf: (p) => ({ kind: "dir", value: p.workingDirectory }),
    },
    "Run terraform apply.",
    z.object({ workingDirectory: cliArg }),
    async (p) => {
      await runCliOkThrowing(
        ["terraform", `-chdir=${p.workingDirectory}`, "apply", "-auto-approve", "-input=false"],
        { ...processEnv },
      );
      return jsonResult({ ok: true });
    },
  );

  registerWriteTool(
    "iac_terraform_destroy",
    {
      mutates: "iac.terraform.destroy",
      // Destroying infrastructure cannot be undone from its own result, and there is nothing
      // queryable to snapshot, so the identifying parameters ARE the pre-state: a record naming
      // WHICH directory was destroyed still beats silence.
      recoverable: false,
      capturePreState: (p) => Promise.resolve({ workingDirectory: p.workingDirectory }),
      scopeTargetOf: (p) => ({ kind: "dir", value: p.workingDirectory }),
    },
    "Run terraform destroy.",
    z.object({ workingDirectory: cliArg }),
    async (p) => {
      await runCliOkThrowing(
        ["terraform", `-chdir=${p.workingDirectory}`, "destroy", "-auto-approve", "-input=false"],
        { ...processEnv },
      );
      return jsonResult({ ok: true });
    },
  );

  registerWriteTool(
    "iac_cloudformation_deploy",
    {
      mutates: "iac.cloudformation.deploy",
      recoverable: true,
      scopeTargetOf: (p) => ({ kind: "stack", value: p.stackName }),
    },
    "Deploy a CloudFormation stack via AWS CLI.",
    z.object({
      stackName: awsCliArg,
      templateBody: templateDocument,
    }),
    async (p) => {
      await withTemplateFile(p.templateBody, (templateFile) =>
        runCliOkThrowing(
          [
            "aws",
            "cloudformation",
            "deploy",
            "--stack-name",
            p.stackName,
            "--template-file",
            templateFile,
            "--capabilities",
            "CAPABILITY_IAM",
            // A deploy of a template that changes nothing has done what was asked, not failed.
            "--no-fail-on-empty-changeset",
          ],
          // The file is UTF-8. Left to itself the CLI reads it in the locale's encoding, and on a
          // Windows machine using cp1252 a template holding "Á" fails to decode while one holding
          // "é" deploys as "Ã©". AWS CLI v2 reads AWS_CLI_FILE_ENCODING and ignores PYTHONUTF8; v1,
          // plain Python, reads PYTHONUTF8 and ignores the other. Both are set.
          { ...processEnv, AWS_CLI_FILE_ENCODING: "UTF-8", PYTHONUTF8: "1" },
        ),
      );
      return jsonResult({ ok: true });
    },
  );

  reg(
    "iac_pulumi_preview",
    "Run pulumi preview in a stack directory.",
    z.object({ workingDirectory: cliArg }),
    async (p) => {
      await runCliOkThrowing(
        ["pulumi", "preview", "--cwd", p.workingDirectory, "--non-interactive"],
        { ...processEnv },
      );
      return jsonResult({ ok: true });
    },
  );

  registerWriteTool(
    "iac_pulumi_up",
    {
      mutates: "iac.pulumi.up",
      recoverable: true,
      scopeTargetOf: (p) => ({ kind: "dir", value: p.workingDirectory }),
    },
    "Run pulumi up.",
    z.object({ workingDirectory: cliArg }),
    async (p) => {
      await runCliOkThrowing(
        ["pulumi", "up", "--yes", "--cwd", p.workingDirectory, "--non-interactive"],
        { ...processEnv },
      );
      return jsonResult({ ok: true });
    },
  );
}
