import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  type CapturedTools,
  captureTools,
  type FetchStub,
  stubFetch,
  withEnv,
} from "../../../scripts/connector-tool-harness.ts";
import { registerPrefectTools } from "../src/tools.ts";

const API = "https://prefect.example.com/api";

let tools: CapturedTools;
let http: FetchStub | undefined;

beforeEach(() => {
  tools = captureTools(registerPrefectTools);
});

afterEach(() => {
  http?.restore();
  http = undefined;
});

function cloud(fn: () => Promise<void>): Promise<void> {
  return withEnv({ PREFECT_API_URL: `${API}/`, PREFECT_API_KEY: "pnu_key" }, fn);
}

describe("prefect never sends its API key across a redirect", () => {
  it("the deployments/filter POST refuses a 3xx instead of replaying it", async () => {
    http = stubFetch({ status: 307, headers: { location: "https://evil.example/steal" } });
    await cloud(async () => {
      await expect(tools.call("prefect_list", {})).rejects.toThrow(
        "Prefect answered a POST with a redirect (307)",
      );
    });
    expect(http.calls.map((c) => c.url)).toEqual([`${API}/deployments/filter`]);
  });
});
