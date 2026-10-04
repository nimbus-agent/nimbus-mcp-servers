import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  type CapturedTools,
  captureTools,
  type SpawnStub,
  stubSpawn,
  withEnv,
} from "../../../scripts/connector-tool-harness.ts";
import { registerVertexAiTools, VERTEX_AI_TOOL_NAMES } from "../src/tools.ts";

const MODELS = [
  { name: "projects/1/locations/us-central1/models/11", displayName: "Churn Predictor" },
  { name: "projects/1/locations/us-central1/models/22", displayName: "fraud-scorer" },
  42,
];

let tools: CapturedTools;
let spawn: SpawnStub | undefined;

function cli(reply: { stdout?: string; stderr?: string; exitCode?: number }): SpawnStub {
  spawn?.restore();
  spawn = stubSpawn(reply);
  return spawn;
}

/** No region or project configured: the defaults apply. */
function defaults(fn: () => Promise<void>): Promise<void> {
  return withEnv({ VERTEX_AI_REGION: undefined, GOOGLE_CLOUD_PROJECT: undefined }, fn);
}

beforeEach(() => {
  tools = captureTools(registerVertexAiTools);
});

afterEach(() => {
  spawn?.restore();
  spawn = undefined;
});

describe("vertex_ai tools", () => {
  it("registers exactly VERTEX_AI_TOOL_NAMES, in order", () => {
    expect(tools.registrationOrder()).toEqual([...VERTEX_AI_TOOL_NAMES]);
  });

  it("list asks gcloud for the models of us-central1 when no region is configured", async () => {
    const stub = cli({ stdout: JSON.stringify(MODELS) });
    await defaults(async () => {
      expect(await tools.callJson("vertex_ai_list", {})).toEqual(MODELS);
    });
    expect(stub.calls.map((c) => c.command)).toEqual([
      ["gcloud", "ai", "models", "list", "--region", "us-central1", "--format", "json"],
    ]);
  });

  it("an explicit region wins over VERTEX_AI_REGION, which wins over the default", async () => {
    const stub = cli({ stdout: "[]" });
    await withEnv(
      { VERTEX_AI_REGION: " europe-west4 ", GOOGLE_CLOUD_PROJECT: "acme" },
      async () => {
        await tools.call("vertex_ai_list", {});
        await tools.call("vertex_ai_list", { region: "asia-east1" });
      },
    );
    expect(stub.calls.map((c) => c.command)).toEqual([
      [
        "gcloud",
        "ai",
        "models",
        "list",
        "--region",
        "europe-west4",
        "--project",
        "acme",
        "--format",
        "json",
      ],
      [
        "gcloud",
        "ai",
        "models",
        "list",
        "--region",
        "asia-east1",
        "--project",
        "acme",
        "--format",
        "json",
      ],
    ]);
  });

  it("refuses a configured region that would be read as a flag, before spawning", async () => {
    // The tool argument is guarded by its schema; the environment value is not, so the handler
    // guards it again before it can reach the argv.
    const stub = cli({ stdout: "[]" });
    await withEnv({ VERTEX_AI_REGION: "--impersonate-service-account=x" }, async () => {
      await expect(tools.call("vertex_ai_list", {})).rejects.toThrow(
        "Invalid region: --impersonate-service-account=x",
      );
    });
    expect(stub.calls).toEqual([]);
  });

  it("list answers an empty list for output that is not a list", async () => {
    cli({ stdout: '{"models":[]}' });
    await defaults(async () => {
      expect(await tools.callJson("vertex_ai_list", {})).toEqual([]);
    });
  });

  it("get describes one model", async () => {
    const stub = cli({ stdout: JSON.stringify(MODELS[0]) });
    await defaults(async () => {
      expect(await tools.callJson("vertex_ai_get", { modelId: "11" })).toEqual(MODELS[0]);
    });
    expect(stub.calls[0]?.command).toEqual([
      "gcloud",
      "ai",
      "models",
      "describe",
      "11",
      "--region",
      "us-central1",
      "--format",
      "json",
    ]);
  });

  it("search matches display names and resource names, case-insensitively", async () => {
    cli({ stdout: JSON.stringify(MODELS) });
    const names = async (query: string): Promise<unknown[]> => {
      let out: unknown;
      await defaults(async () => {
        out = await tools.callJson("vertex_ai_search", { query });
      });
      return (out as { matches: { displayName: string }[] }).matches.map((m) => m.displayName);
    };
    expect(await names("CHURN")).toEqual(["Churn Predictor"]);
    expect(await names("models/22")).toEqual(["fraud-scorer"]);
    expect(await names("us-central1")).toEqual(["Churn Predictor", "fraud-scorer"]);
    expect(await names("forecast")).toEqual([]);
  });

  it("throws gcloud's stderr when the CLI fails", async () => {
    cli({ exitCode: 2, stdout: "", stderr: "ERROR: Vertex AI API has not been used" });
    await defaults(async () => {
      await expect(tools.call("vertex_ai_get", { modelId: "11" })).rejects.toThrow(
        "gcloud ai models failed: ERROR: Vertex AI API has not been used",
      );
    });
  });
});
