import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { ConsentServer } from "../../../shared/consent-kit.ts";
import { createWriteToolRegistrar } from "../../../shared/consent-kit.ts";
import {
  createRegisterSimpleTool,
  createZodToolRegistrar,
  mcpJsonResult as jsonResult,
} from "../../../shared/mcp-tool-kit.ts";
import { runCliJsonThrowing, runCliOkThrowing } from "../../../shared/run-cli-json.ts";

function awsEnv(): Record<string, string | undefined> {
  const e = { ...process.env } as Record<string, string | undefined>;
  const ak = process.env["AWS_ACCESS_KEY_ID"]?.trim();
  const sk = process.env["AWS_SECRET_ACCESS_KEY"]?.trim();
  const rg = process.env["AWS_DEFAULT_REGION"]?.trim();
  const profile = process.env["AWS_PROFILE"]?.trim();
  if (ak !== undefined && ak !== "") {
    e["AWS_ACCESS_KEY_ID"] = ak;
  }
  if (sk !== undefined && sk !== "") {
    e["AWS_SECRET_ACCESS_KEY"] = sk;
  }
  if (rg !== undefined && rg !== "") {
    e["AWS_DEFAULT_REGION"] = rg;
  }
  if (profile !== undefined && profile !== "") {
    e["AWS_PROFILE"] = profile;
  }
  return e;
}

async function awsJson(args: string[]): Promise<unknown> {
  const cmd = ["aws", ...args, "--output", "json"];
  return (await runCliJsonThrowing(cmd, awsEnv())) ?? {};
}

/** Tool names exposed by this connector — for contract/introspection tests. */
export const AWS_TOOL_NAMES = [
  "aws_ecs_service_list",
  "aws_lambda_list",
  "aws_ecs_service_update",
  "aws_lambda_invoke",
  "aws_ec2_instance_stop",
  "aws_ec2_instance_start",
] as const;

export function registerAwsTools(
  server: ConsentServer & { tool: (...args: never) => unknown },
): void {
  const reg = createZodToolRegistrar(createRegisterSimpleTool(server));

  /**
   * Every MUTATING aws tool goes through here. Outside the gateway this adds the
   * consent gate, the write-scope allow-list, the mutation budget and the audit record; inside
   * the gateway it is a pass-through, because executor.ts (I2) is the gate there.
   */
  const registerWriteTool = createWriteToolRegistrar(server, {
    connector: "aws",
    scopeEnv: "NIMBUS_MCP_AWS_WRITE_SCOPE",
    scopeKinds: ["cluster", "function", "instance"],
  });

  reg(
    "aws_ecs_service_list",
    "List ECS services in a cluster.",
    z.object({ cluster: z.string().min(1) }),
    async (p) => jsonResult(await awsJson(["ecs", "list-services", "--cluster", p.cluster])),
  );

  reg("aws_lambda_list", "List Lambda functions (first page).", z.object({}), async () =>
    jsonResult(await awsJson(["lambda", "list-functions"])),
  );

  registerWriteTool(
    "aws_ecs_service_update",
    {
      mutates: "aws.ecs.service.update",
      recoverable: true,
      scopeTargetOf: (p) => ({ kind: "cluster", value: p.cluster }),
    },
    "Update ECS service (e.g. new task definition).",
    z.object({
      cluster: z.string().min(1),
      service: z.string().min(1),
      taskDefinition: z.string().min(1),
    }),
    async (p) => {
      const cmd = [
        "aws",
        "ecs",
        "update-service",
        "--cluster",
        p.cluster,
        "--service",
        p.service,
        "--task-definition",
        p.taskDefinition,
        "--force-new-deployment",
      ];
      await runCliOkThrowing(cmd, awsEnv());
      return jsonResult({ ok: true });
    },
  );

  registerWriteTool(
    "aws_lambda_invoke",
    {
      mutates: "aws.lambda.invoke",
      recoverable: true,
      scopeTargetOf: (p) => ({ kind: "function", value: p.functionName }),
    },
    "Invoke a Lambda function.",
    z.object({
      functionName: z.string().min(1),
      payloadJson: z.string().optional(),
    }),
    async (p) => {
      const dir = mkdtempSync(join(tmpdir(), "nimbus-aws-lambda-"));
      const outFile = join(dir, "response.json");
      if (p.payloadJson !== undefined && p.payloadJson !== "") {
        const pf = join(dir, "payload.json");
        writeFileSync(pf, p.payloadJson, "utf8");
        const cmd = [
          "aws",
          "lambda",
          "invoke",
          "--function-name",
          p.functionName,
          "--payload",
          `file://${pf}`,
          outFile,
        ];
        await runCliOkThrowing(cmd, awsEnv());
      } else {
        await runCliOkThrowing(
          ["aws", "lambda", "invoke", "--function-name", p.functionName, outFile],
          awsEnv(),
        );
      }
      let body: unknown;
      try {
        body = JSON.parse(readFileSync(outFile, "utf8")) as unknown;
      } catch {
        body = { ok: true };
      }
      return jsonResult(body);
    },
  );

  // The two EC2 actions are WRITES. They were registered as reads, which in standalone mode offered
  // them to every client with no consent prompt, scope check, budget or audit record.
  registerWriteTool(
    "aws_ec2_instance_stop",
    {
      mutates: "aws.ec2.instance.stop",
      recoverable: true,
      scopeTargetOf: (p) => ({ kind: "instance", value: p.instanceIds }),
    },
    "Stop EC2 instances.",
    z.object({ instanceIds: z.string().min(1) }),
    async (p) => {
      await runCliOkThrowing(
        ["aws", "ec2", "stop-instances", "--instance-ids", p.instanceIds],
        awsEnv(),
      );
      return jsonResult({ ok: true });
    },
  );

  registerWriteTool(
    "aws_ec2_instance_start",
    {
      mutates: "aws.ec2.instance.start",
      recoverable: true,
      scopeTargetOf: (p) => ({ kind: "instance", value: p.instanceIds }),
    },
    "Start EC2 instances.",
    z.object({ instanceIds: z.string().min(1) }),
    async (p) => {
      await runCliOkThrowing(
        ["aws", "ec2", "start-instances", "--instance-ids", p.instanceIds],
        awsEnv(),
      );
      return jsonResult({ ok: true });
    },
  );
}
