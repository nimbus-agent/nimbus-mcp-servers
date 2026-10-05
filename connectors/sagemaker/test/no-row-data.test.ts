import { describe, expect, it } from "bun:test";
import { assertNoRowDataTools } from "@nimbus-dev/sdk";
import { awsCliArg, SAGEMAKER_TOOL_NAMES } from "../src/tools.ts";

/**
 * Tier-3 no-row-data contract. SageMaker exposes only model-REGISTRY metadata
 * tools; this locks that in. A future edit adding a `sagemaker_invoke_endpoint`
 * / `sagemaker_predict` / `sagemaker_get_records` / `sagemaker_query` /
 * `sagemaker_scan` tool makes `assertNoRowDataTools` throw, failing CI.
 */
describe("SageMaker no-row-data contract (Tier-3)", () => {
  it("exposes only metadata tools — assertNoRowDataTools does not throw", () => {
    const tools = SAGEMAKER_TOOL_NAMES.map((name) => ({ name }));
    expect(() => assertNoRowDataTools(tools, "sagemaker")).not.toThrow();
  });

  it("registers the expected metadata-only tool surface", () => {
    expect([...SAGEMAKER_TOOL_NAMES]).toEqual([
      "sagemaker_list",
      "sagemaker_get",
      "sagemaker_search",
    ]);
  });

  it("rejects a hypothetical row-data tool (assertion is live)", () => {
    expect(() => assertNoRowDataTools([{ name: "sagemaker_get_records" }], "sagemaker")).toThrow();
    expect(() => assertNoRowDataTools([{ name: "sagemaker_scan" }], "sagemaker")).toThrow();
  });
});

/**
 * Security guard: every tool-input value passed to the `aws sagemaker` CLI flows
 * through the `awsCliArg` Zod field, which rejects argv flag-smuggling and the
 * values the CLI would replace by a file's contents. A model name beginning with
 * `-` (or carrying control chars, or `file://`) must fail the schema before the
 * handler ever shells out.
 */
describe("SageMaker awsCliArg flag-smuggling guard", () => {
  it("rejects a model name the CLI would read from a local file or a URL", () => {
    expect(awsCliArg.safeParse("file:///etc/passwd").success).toBe(false);
    expect(awsCliArg.safeParse("fileb://C:/Users/me/.aws/credentials").success).toBe(false);
    expect(awsCliArg.safeParse("https://example.invalid/model").success).toBe(false);
  });

  it("accepts a normal model name", () => {
    expect(awsCliArg.safeParse("my-fraud-model").success).toBe(true);
  });

  it("rejects a `-`-prefixed model name (argv flag smuggling)", () => {
    expect(awsCliArg.safeParse("--model-name=attacker").success).toBe(false);
    expect(awsCliArg.safeParse("-h").success).toBe(false);
  });

  it("rejects an empty model name", () => {
    expect(awsCliArg.safeParse("").success).toBe(false);
  });

  it("rejects a model name with control characters", () => {
    expect(awsCliArg.safeParse("model\nname").success).toBe(false);
  });
});
