import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { awsCliArg } from "../../../shared/cli-json-kit.ts";
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

/** One EC2 instance id: `i-` and 8 to 17 lowercase hex digits (the long and the legacy short form). */
const ec2InstanceId = awsCliArg.regex(/^i-[0-9a-f]{8,17}$/, "not an EC2 instance id (i-...)");

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * The projection of `aws ec2 describe-instances --instance-ids <id>`. Field names are those on
 * https://docs.aws.amazon.com/cli/latest/reference/ec2/describe-instances.html:
 * `Reservations[].Instances[]` with `InstanceId`, `InstanceType`, `LaunchTime`, `State{Code,Name}`,
 * `IamInstanceProfile{Arn,Id}` and `Tags[]{Key,Value}`. No instance in the reply (AWS omits one you
 * do not own) throws "instance not found".
 */
function projectInstance(raw: unknown): Record<string, unknown> {
  const reservations =
    isRecord(raw) && Array.isArray(raw["Reservations"]) ? raw["Reservations"] : [];
  for (const r of reservations) {
    const instances = isRecord(r) && Array.isArray(r["Instances"]) ? r["Instances"] : [];
    for (const i of instances) {
      if (!isRecord(i) || typeof i["InstanceId"] !== "string") continue;
      const state = isRecord(i["State"]) ? i["State"]["Name"] : undefined;
      const profile = isRecord(i["IamInstanceProfile"])
        ? i["IamInstanceProfile"]["Arn"]
        : undefined;
      const tags = (Array.isArray(i["Tags"]) ? i["Tags"] : [])
        .filter(isRecord)
        .map((t) => ({ key: t["Key"], value: t["Value"] }));
      return {
        instanceId: i["InstanceId"],
        state: typeof state === "string" ? state : undefined,
        instanceType: i["InstanceType"],
        launchTime: i["LaunchTime"],
        tags,
        iamProfileArn: typeof profile === "string" ? profile : undefined,
      };
    }
  }
  throw new Error("instance not found");
}

/**
 * The projection of `aws ecs describe-services --cluster X --services Y`
 * (https://docs.aws.amazon.com/cli/latest/reference/ecs/describe-services.html): `services[]` with
 * `serviceName, status, desiredCount, runningCount, taskDefinition, launchType`, and `failures[]`
 * for a service it could not describe (a missing one comes back there, with exit code 0). A service
 * in `failures` with none in `services`, or no entry in `services` at all, is "service not found".
 * An INACTIVE service is still listed by the API and is reported with its status.
 */
function projectEcsService(raw: unknown): Record<string, unknown> {
  const services = isRecord(raw) && Array.isArray(raw["services"]) ? raw["services"] : [];
  const service = services.find((s) => isRecord(s) && typeof s["serviceName"] === "string");
  if (!isRecord(service)) throw new Error("service not found");
  const out: Record<string, unknown> = {};
  for (const k of [
    "serviceName",
    "status",
    "desiredCount",
    "runningCount",
    "taskDefinition",
    "launchType",
  ] as const) {
    if (service[k] !== undefined && service[k] !== null) out[k] = service[k];
  }
  return out;
}

/** Tool names exposed by this connector — for contract/introspection tests. */
export const AWS_TOOL_NAMES = [
  "aws_ecs_service_list",
  "aws_ecs_service_get",
  "aws_lambda_list",
  "aws_ec2_instance_get",
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
    z.object({ cluster: awsCliArg }),
    async (p) => jsonResult(await awsJson(["ecs", "list-services", "--cluster", p.cluster])),
  );

  reg(
    "aws_ecs_service_get",
    "Get one ECS service's state: {serviceName, status, desiredCount, runningCount, taskDefinition, launchType}. The before-state of aws_ecs_service_update; same cluster and service. A service the API reports as a failure, or does not return, is 'service not found'.",
    z.object({ cluster: awsCliArg, service: awsCliArg }),
    async (p) =>
      jsonResult(
        projectEcsService(
          await awsJson([
            "ecs",
            "describe-services",
            "--cluster",
            p.cluster,
            "--services",
            p.service,
          ]),
        ),
      ),
  );

  reg("aws_lambda_list", "List Lambda functions (first page).", z.object({}), async () =>
    jsonResult(await awsJson(["lambda", "list-functions"])),
  );

  reg(
    "aws_ec2_instance_get",
    "Get one EC2 instance's state: {instanceId, state, instanceType, launchTime, tags, iamProfileArn}. The before-state of a start or a stop.",
    z.object({ instanceId: ec2InstanceId }),
    async (p) => {
      try {
        return jsonResult(
          projectInstance(
            await awsJson(["ec2", "describe-instances", "--instance-ids", p.instanceId]),
          ),
        );
      } catch (e) {
        // The error code for a well-formed id that does not exist is InvalidInstanceID.NotFound
        // (EC2 error codes); the describe-instances page names none, so the code is matched here.
        if (e instanceof Error && /InvalidInstanceID.NotFound/.test(e.message)) {
          throw new Error("instance not found", { cause: e });
        }
        throw e;
      }
    },
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
      cluster: awsCliArg,
      service: awsCliArg,
      taskDefinition: awsCliArg,
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
      functionName: awsCliArg,
      // Written to a temp file the CLI is pointed at with file://, never passed as an argument.
      payloadJson: z.string().optional(),
    }),
    async (p) => {
      // The CLI reads the payload from a file and writes the response to one. Both are the
      // caller's data, so the directory holding them is removed however the call ends — it used
      // to be left in the temp dir on every invocation.
      const dir = mkdtempSync(join(tmpdir(), "nimbus-aws-lambda-"));
      try {
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
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
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
    z.object({ instanceIds: awsCliArg }),
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
    z.object({ instanceIds: awsCliArg }),
    async (p) => {
      await runCliOkThrowing(
        ["aws", "ec2", "start-instances", "--instance-ids", p.instanceIds],
        awsEnv(),
      );
      return jsonResult({ ok: true });
    },
  );
}
