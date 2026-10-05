import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  type CapturedTools,
  captureStandaloneTools,
  captureTools,
  refusalSaying,
  type SpawnStub,
  type StandaloneCapture,
  stubSpawn,
  withEnv,
} from "../../../scripts/connector-tool-harness.ts";
import { resetConnectorModeForTests, setConnectorMode } from "../../../shared/connector-mode.ts";
import { registerAwsTools } from "../src/tools.ts";

let tools: CapturedTools;
let spawn: SpawnStub | undefined;
/** Directories aws_lambda_invoke created during a test, removed afterwards by full path. */
const lambdaDirs = new Set<string>();

/** Answer every aws call with this reply, replacing any stub already installed. */
function cli(reply: Parameters<typeof stubSpawn>[0]): SpawnStub {
  spawn?.restore();
  spawn = stubSpawn(reply);
  return spawn;
}

/** Remember the temp dir a lambda invocation wrote into, so it can be removed. */
function trackLambdaDir(command: readonly string[] | undefined): void {
  const outFile = command?.at(-1);
  if (outFile === undefined) return;
  const dir = dirname(outFile);
  // Only ever a directory the connector made under the system temp dir, never anything else.
  if (dir.startsWith(join(tmpdir(), "nimbus-aws-lambda-"))) lambdaDirs.add(dir);
}

/**
 * Assert the temp dir an invocation wrote into is gone. Checked to BE such a directory first, so a
 * command that recorded no response path cannot pass as "nothing left behind".
 */
function expectLambdaDirRemoved(command: readonly string[] | undefined): void {
  trackLambdaDir(command);
  const dir = dirname(command?.at(-1) ?? "");
  expect(dir.startsWith(join(tmpdir(), "nimbus-aws-lambda-"))).toBe(true);
  expect(existsSync(dir)).toBe(false);
}

beforeEach(() => {
  resetConnectorModeForTests();
  setConnectorMode("gateway");
  tools = captureTools(registerAwsTools);
});

afterEach(() => {
  spawn?.restore();
  spawn = undefined;
  for (const dir of lambdaDirs) rmSync(dir, { recursive: true, force: true });
  lambdaDirs.clear();
  resetConnectorModeForTests();
});

const OK_COMMANDS: readonly {
  readonly tool: string;
  readonly args: Record<string, unknown>;
  readonly argv: readonly string[];
}[] = [
  {
    tool: "aws_ecs_service_update",
    args: { cluster: "c1", service: "api", taskDefinition: "api:7" },
    argv: [
      "aws",
      "ecs",
      "update-service",
      "--cluster",
      "c1",
      "--service",
      "api",
      "--task-definition",
      "api:7",
      "--force-new-deployment",
    ],
  },
  {
    tool: "aws_ec2_instance_stop",
    args: { instanceIds: "i-1 i-2" },
    argv: ["aws", "ec2", "stop-instances", "--instance-ids", "i-1 i-2"],
  },
  {
    tool: "aws_ec2_instance_start",
    args: { instanceIds: "i-1" },
    argv: ["aws", "ec2", "start-instances", "--instance-ids", "i-1"],
  },
];

describe("aws mutating tools", () => {
  for (const { tool, args, argv } of OK_COMMANDS) {
    it(`${tool} runs exactly its aws command and reports ok`, async () => {
      const stub = cli({ stdout: "" });
      expect(await tools.callJson(tool, args)).toEqual({ ok: true });
      expect(stub.calls.map((c) => c.command)).toEqual([[...argv]]);
    });

    it(`${tool} throws aws's exit code and stderr`, async () => {
      cli({ exitCode: 254, stderr: "AccessDenied" });
      await expect(tools.call(tool, args)).rejects.toThrow("aws exited 254: AccessDenied");
    });
  }
});

describe("aws_lambda_invoke", () => {
  it("invokes without a payload file when none is given", async () => {
    const stub = cli({ stdout: "" });
    // Nothing is written to the response file by the stub, so the fallback answer is reported.
    expect(await tools.callJson("aws_lambda_invoke", { functionName: "fn" })).toEqual({
      ok: true,
    });
    const command = stub.calls[0]?.command;
    expect(command?.slice(0, 5)).toEqual(["aws", "lambda", "invoke", "--function-name", "fn"]);
    expect(command).toHaveLength(6);
    expectLambdaDirRemoved(command);
  });

  it("hands the CLI the payload as a file and answers with the function's response", async () => {
    let payloadSeen: string | undefined;
    const stub = cli({
      stdout: "",
      // What the real CLI does while it runs: read the payload file, write the response file.
      onSpawn: (command) => {
        payloadSeen = readFileSync((command[6] ?? "").slice("file://".length), "utf8");
        writeFileSync(command.at(-1) ?? "", '{"StatusCode":200}', "utf8");
      },
    });
    expect(
      await tools.callJson("aws_lambda_invoke", { functionName: "fn", payloadJson: '{"a":1}' }),
    ).toEqual({ StatusCode: 200 });
    const command = stub.calls[0]?.command;
    expect(command?.slice(0, 6)).toEqual([
      "aws",
      "lambda",
      "invoke",
      "--function-name",
      "fn",
      "--payload",
    ]);
    expect(command?.[6]).toStartWith("file://");
    expect(payloadSeen).toBe('{"a":1}');
    // The payload and the response are the caller's data: neither stays in the temp dir.
    expectLambdaDirRemoved(command);
  });

  for (const payloadJson of [undefined, '{"a":1}']) {
    it(`throws aws's exit code and stderr, leaving nothing behind (${payloadJson === undefined ? "no " : ""}payload)`, async () => {
      const stub = cli({ exitCode: 255, stderr: "ResourceNotFound" });
      await expect(
        tools.call("aws_lambda_invoke", {
          functionName: "fn",
          ...(payloadJson === undefined ? {} : { payloadJson }),
        }),
      ).rejects.toThrow("aws exited 255: ResourceNotFound");
      expectLambdaDirRemoved(stub.calls[0]?.command);
    });
  }
});

describe("aws refuses a value the CLI would load from a file or a URL, before aws runs", () => {
  // The AWS CLI replaces a parameter written file://<path> or fileb://<path> by that file, and v1
  // fetches an http(s) URL the same way; an error naming the value it rejects can then quote
  // what it read back to the caller.
  const CASES: readonly (readonly [string, Record<string, unknown>, string])[] = [
    ["aws_ecs_service_list", { cluster: "file:///etc/hosts" }, 'must not start with "file://"'],
    [
      "aws_ecs_service_update",
      { cluster: "c1", service: "fileb://C:/Users/me/.aws/credentials", taskDefinition: "api:7" },
      'must not start with "fileb://"',
    ],
    [
      "aws_lambda_invoke",
      { functionName: "http://169.254.169.254/latest/meta-data/iam/security-credentials/" },
      'must not start with "http://"',
    ],
    [
      "aws_ec2_instance_stop",
      { instanceIds: "https://example.invalid/i" },
      'must not start with "https://"',
    ],
    [
      "aws_ecs_service_update",
      { cluster: "c1", service: "api", taskDefinition: "Body@=file:///etc/hosts" },
      'must not contain "@="',
    ],
    ["aws_ec2_instance_start", { instanceIds: "--dry-run" }, 'must not start with "-"'],
  ];

  for (const [tool, args, refusal] of CASES) {
    it(`${tool} refuses ${JSON.stringify(args)}`, async () => {
      const stub = cli({ stdout: "" });
      await expect(tools.call(tool, args)).rejects.toThrow(refusalSaying(refusal));
      expect(stub.calls).toEqual([]);
    });
  }
});

describe("aws list tools", () => {
  it("aws_ecs_service_list asks for JSON output and returns it", async () => {
    const stub = cli({ stdout: '{"serviceArns":["arn:a"]}' });
    expect(await tools.callJson("aws_ecs_service_list", { cluster: "c1" })).toEqual({
      serviceArns: ["arn:a"],
    });
    expect(stub.calls[0]?.command).toEqual([
      "aws",
      "ecs",
      "list-services",
      "--cluster",
      "c1",
      "--output",
      "json",
    ]);
  });

  it("an empty answer is reported as an empty object", async () => {
    cli({ stdout: "" });
    expect(await tools.callJson("aws_lambda_list", {})).toEqual({});
  });

  it("throws aws's exit code and stderr", async () => {
    cli({ exitCode: 253, stderr: "no credentials" });
    await expect(tools.call("aws_lambda_list", {})).rejects.toThrow(
      "aws exited 253: no credentials",
    );
  });

  it("hands aws the credentials, region and profile trimmed of surrounding whitespace", async () => {
    const stub = cli({ stdout: "{}" });
    await withEnv(
      {
        AWS_ACCESS_KEY_ID: " AKIATEST\n",
        AWS_SECRET_ACCESS_KEY: "\tsecret ",
        AWS_DEFAULT_REGION: " eu-west-1 ",
        AWS_PROFILE: " prod ",
      },
      async () => {
        await tools.call("aws_lambda_list", {});
      },
    );
    const env = stub.calls[0]?.env ?? {};
    expect([
      env["AWS_ACCESS_KEY_ID"],
      env["AWS_SECRET_ACCESS_KEY"],
      env["AWS_DEFAULT_REGION"],
      env["AWS_PROFILE"],
    ]).toEqual(["AKIATEST", "secret", "eu-west-1", "prod"]);
  });
});

describe("the EC2 actions are gated writes (standalone mode)", () => {
  /** Register in standalone mode for a client that can (or cannot) prompt, with i-1 in scope. */
  async function standalone(elicitation: boolean): Promise<StandaloneCapture> {
    resetConnectorModeForTests();
    setConnectorMode("standalone");
    let captured: StandaloneCapture | undefined;
    await withEnv(
      { NIMBUS_MCP_AWS_WRITE_SCOPE: "instance:i-1", NIMBUS_MCP_AUDIT_LOG: undefined },
      () => {
        captured = captureStandaloneTools(registerAwsTools, { elicitation });
      },
    );
    if (captured === undefined) throw new Error("registration did not run");
    return captured;
  }

  for (const [tool, action] of [
    ["aws_ec2_instance_stop", "aws.ec2.instance.stop"],
    ["aws_ec2_instance_start", "aws.ec2.instance.start"],
  ] as const) {
    it(`${tool} is not offered at all to a client that cannot prompt a human`, async () => {
      const names = (await standalone(false)).tools.names();
      expect(names).not.toContain(tool);
      expect(names).toContain("aws_lambda_list");
    });

    it(`${tool} runs on an in-scope instance only after the human approved it`, async () => {
      const { tools: gated, prompts } = await standalone(true);
      const stub = cli({ stdout: "" });
      expect(await gated.callJson(tool, { instanceIds: "i-1" })).toEqual({ ok: true });
      expect(stub.calls).toHaveLength(1);
      expect(prompts).toHaveLength(1);
      expect(prompts[0]).toContain(action);
    });

    it(`${tool} refuses an out-of-scope instance without prompting or running aws`, async () => {
      const { tools: gated, prompts } = await standalone(true);
      const stub = cli({ stdout: "" });
      expect(await gated.callJson(tool, { instanceIds: "i-2" })).toEqual({
        ok: false,
        error: "out of scope: instance:i-2 is not in NIMBUS_MCP_AWS_WRITE_SCOPE",
      });
      expect(prompts).toEqual([]);
      expect(stub.calls).toEqual([]);
    });
  }
});
