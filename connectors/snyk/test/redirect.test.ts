import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  type CapturedTools,
  captureTools,
  type FetchStub,
  stubFetch,
} from "../../../scripts/connector-tool-harness.ts";
import { registerSnykTools } from "../src/tools.ts";

let tools: CapturedTools;
let stub: FetchStub | undefined;

beforeEach(() => {
  process.env["SNYK_TOKEN"] = "snyk-token";
  tools = captureTools(registerSnykTools);
});

afterEach(() => {
  stub?.restore();
  stub = undefined;
  delete process.env["SNYK_TOKEN"];
});

describe("snyk never sends its token across a redirect", () => {
  it("the aggregated-issues POST refuses a 3xx instead of replaying it", async () => {
    stub = stubFetch({ status: 307, headers: { location: "https://evil.example/steal" } });
    await expect(tools.call("snyk_list", { orgId: "org-1", projectId: "proj-1" })).rejects.toThrow(
      "Snyk answered a POST with a redirect (307); refused (a read: nothing was written)",
    );
    expect(stub.calls).toHaveLength(1);
    expect(stub.only.url).toBe("https://api.snyk.io/v1/org/org-1/project/proj-1/aggregated-issues");
  });
});
