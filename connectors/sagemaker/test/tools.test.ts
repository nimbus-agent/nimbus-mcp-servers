import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  type CapturedTools,
  captureTools,
  type SpawnStub,
  stubSpawn,
} from "../../../scripts/connector-tool-harness.ts";
import { registerSagemakerTools, SAGEMAKER_TOOL_NAMES } from "../src/tools.ts";

const MODELS = {
  Models: [
    { ModelName: "churn-xgboost", ModelArn: "arn:aws:sagemaker:us-east-1:1:model/churn-xgboost" },
    { ModelName: "Fraud-Detector", ModelArn: "arn:aws:sagemaker:us-east-1:1:model/fraud" },
    null,
  ],
};

let tools: CapturedTools;
let spawn: SpawnStub | undefined;

function cli(reply: { stdout?: string; stderr?: string; exitCode?: number }): SpawnStub {
  spawn?.restore();
  spawn = stubSpawn(reply);
  return spawn;
}

beforeEach(() => {
  tools = captureTools(registerSagemakerTools);
});

afterEach(() => {
  spawn?.restore();
  spawn = undefined;
});

describe("sagemaker tools", () => {
  it("registers exactly SAGEMAKER_TOOL_NAMES, in order", () => {
    expect(tools.registrationOrder()).toEqual([...SAGEMAKER_TOOL_NAMES]);
  });

  it("list asks for one page of 50 models as JSON", async () => {
    const stub = cli({ stdout: JSON.stringify(MODELS) });
    expect(await tools.callJson("sagemaker_list", {})).toEqual(MODELS);
    expect(stub.calls.map((c) => c.command)).toEqual([
      ["aws", "sagemaker", "list-models", "--max-results", "50", "--output", "json"],
    ]);
  });

  it("list passes a name filter through to the CLI", async () => {
    const stub = cli({ stdout: "{}" });
    await tools.call("sagemaker_list", { nameContains: "churn" });
    expect(stub.calls[0]?.command).toEqual([
      "aws",
      "sagemaker",
      "list-models",
      "--max-results",
      "50",
      "--name-contains",
      "churn",
      "--output",
      "json",
    ]);
  });

  it("list answers {} when the CLI prints nothing", async () => {
    cli({ stdout: "" });
    expect(await tools.callJson("sagemaker_list", {})).toEqual({});
  });

  it("get describes one model by name", async () => {
    const stub = cli({ stdout: '{"ModelName":"churn-xgboost"}' });
    expect(await tools.callJson("sagemaker_get", { modelName: "churn-xgboost" })).toEqual({
      ModelName: "churn-xgboost",
    });
    expect(stub.calls[0]?.command).toEqual([
      "aws",
      "sagemaker",
      "describe-model",
      "--model-name",
      "churn-xgboost",
      "--output",
      "json",
    ]);
  });

  it("get refuses a model name that would be read as a CLI flag, before spawning", async () => {
    const stub = cli({ stdout: "{}" });
    await expect(
      tools.call("sagemaker_get", { modelName: "--endpoint-url=https://evil.example" }),
    ).rejects.toThrow(/"modelName"[\s\S]*must not start with/);
    expect(stub.calls).toEqual([]);
  });

  it("search matches model names case-insensitively and skips malformed entries", async () => {
    cli({ stdout: JSON.stringify(MODELS) });
    const names = async (query: string): Promise<unknown[]> =>
      (
        (await tools.callJson("sagemaker_search", { query })) as {
          matches: { ModelName: string }[];
        }
      ).matches.map((m) => m.ModelName);
    expect(await names("FRAUD")).toEqual(["Fraud-Detector"]);
    expect(await names("-")).toEqual(["churn-xgboost", "Fraud-Detector"]);
    expect(await names("forecast")).toEqual([]);
  });

  it("search finds nothing when the CLI answer carries no Models list", async () => {
    cli({ stdout: '{"NextToken":"abc"}' });
    expect(await tools.callJson("sagemaker_search", { query: "x" })).toEqual({ matches: [] });
  });

  it("throws the CLI's stderr when it fails", async () => {
    cli({ exitCode: 255, stdout: "", stderr: "An error occurred (AccessDeniedException)" });
    await expect(tools.call("sagemaker_list", {})).rejects.toThrow(
      "aws sagemaker list-models failed: An error occurred (AccessDeniedException)",
    );
  });
});
