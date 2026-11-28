import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  type CapturedTools,
  captureTools,
  type FetchStub,
  stubFetch,
  withEnv,
} from "../../../scripts/connector-tool-harness.ts";
import { registerGoogleMeetTools } from "../src/tools.ts";

let tools: CapturedTools;
let http: FetchStub | undefined;

beforeEach(() => {
  tools = captureTools(registerGoogleMeetTools);
});

afterEach(() => {
  http?.restore();
  http = undefined;
});

describe("google meet never sends its token across a redirect", () => {
  it("a read refuses a redirect to another origin and sends nothing there", async () => {
    http = stubFetch({ status: 302, headers: { location: "https://evil.example/steal" } });
    await withEnv({ GOOGLE_OAUTH_ACCESS_TOKEN: "ya29.meet" }, async () => {
      await expect(tools.call("google_meet_list", {})).rejects.toThrow(
        "Google Meet redirected to another origin; refused",
      );
    });
    expect(http.calls.map((c) => c.url)).toEqual([
      "https://meet.googleapis.com/v2/conferenceRecords?pageSize=50",
    ]);
    expect(http.only.redirect).toBe("manual");
  });
});
