import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  type CapturedTools,
  captureTools,
  type FetchStub,
  type SpawnStub,
  stubFetch,
  stubSpawn,
  withEnv,
} from "../../../scripts/connector-tool-harness.ts";
import { registerBigqueryTools } from "../src/tools.ts";

const BASE = "https://bigquery.googleapis.com/bigquery/v2";

let tools: CapturedTools;
let spawn: SpawnStub;
let http: FetchStub | undefined;

beforeEach(() => {
  spawn = stubSpawn({ stdout: "ya29.test-token\n" });
  tools = captureTools(registerBigqueryTools);
});

afterEach(() => {
  spawn.restore();
  http?.restore();
  http = undefined;
});

describe("bigquery never sends its access token across a redirect", () => {
  it("a read refuses a redirect to another origin and sends nothing there", async () => {
    http = stubFetch({ status: 302, headers: { location: "https://evil.example/steal" } });
    await withEnv({ BIGQUERY_PROJECT: "acme" }, async () => {
      await expect(tools.call("bigquery_list", {})).rejects.toThrow(
        "BigQuery redirected to another origin; refused",
      );
    });
    expect(http.calls.map((c) => c.url)).toEqual([`${BASE}/projects/acme/datasets?maxResults=200`]);
    expect(http.only.redirect).toBe("manual");
  });
});
