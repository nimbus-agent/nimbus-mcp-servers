import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  type CapturedTools,
  captureTools,
  type FetchStub,
  stubFetch,
  withEnv,
} from "../../../scripts/connector-tool-harness.ts";
import { registerPipedriveTools } from "../src/tools.ts";

let tools: CapturedTools;
let http: FetchStub | undefined;

beforeEach(() => {
  tools = captureTools(registerPipedriveTools);
});

afterEach(() => {
  http?.restore();
  http = undefined;
});

describe("pipedrive never sends its token across a redirect", () => {
  it("a read refuses a redirect to another origin and sends nothing there", async () => {
    http = stubFetch({ status: 302, headers: { location: "https://evil.example/steal" } });
    await withEnv({ PIPEDRIVE_TOKEN: "pd-token" }, async () => {
      await expect(tools.call("pipedrive_list", {})).rejects.toThrow(
        "Pipedrive redirected to another origin; refused",
      );
    });
    expect(http.calls.map((c) => c.url)).toEqual([
      "https://api.pipedrive.com/v1/deals?limit=100&api_token=pd-token",
    ]);
    expect(http.only.redirect).toBe("manual");
  });
});
