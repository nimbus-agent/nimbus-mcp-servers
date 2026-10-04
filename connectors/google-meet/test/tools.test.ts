import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  type CapturedTools,
  captureTools,
  type FetchStub,
  type RecordedRequest,
  type StubReply,
  stubFetch,
  withEnv,
} from "../../../scripts/connector-tool-harness.ts";
import { registerGoogleMeetTools } from "../src/tools.ts";

const API = "https://meet.googleapis.com/v2";

let tools: CapturedTools;
let http: FetchStub | undefined;

function serve(reply: StubReply = '{"conferenceRecords":[]}'): FetchStub {
  http?.restore();
  http = stubFetch(reply);
  return http;
}

/** Call `name` with the OAuth token set; return the one request it made. */
async function request(name: string, args: Record<string, unknown>): Promise<RecordedRequest> {
  const stub = serve();
  await withEnv({ GOOGLE_OAUTH_ACCESS_TOKEN: "ya29.meet" }, async () => {
    await tools.call(name, args);
  });
  return stub.only;
}

beforeEach(() => {
  tools = captureTools(registerGoogleMeetTools);
});

afterEach(() => {
  http?.restore();
  http = undefined;
});

describe("google meet tools", () => {
  it("registers the three conference-record tools", () => {
    expect(tools.names()).toEqual(["google_meet_get", "google_meet_list", "google_meet_search"]);
  });

  it("list asks for 50 conference records once under the API base, with the bearer token", async () => {
    const req = await request("google_meet_list", {});
    expect(req.url).toBe(`${API}/conferenceRecords?pageSize=50`);
    expect(req.headers["authorization"]).toBe("Bearer ya29.meet");
  });

  it("list pages by size and token, and drops an empty token", async () => {
    expect((await request("google_meet_list", { pageSize: 10, pageToken: "t 2" })).url).toBe(
      `${API}/conferenceRecords?pageSize=10&pageToken=t+2`,
    );
    expect((await request("google_meet_list", { pageToken: "" })).url).toBe(
      `${API}/conferenceRecords?pageSize=50`,
    );
  });

  it("search adds the Meet filter expression after the paging, when one is given", async () => {
    expect(
      (
        await request("google_meet_search", {
          pageToken: "p2",
          filter: 'space.name = "spaces/abc"',
        })
      ).url,
    ).toBe(
      `${API}/conferenceRecords?pageSize=50&pageToken=p2&filter=space.name+%3D+%22spaces%2Fabc%22`,
    );
    expect((await request("google_meet_search", { filter: "" })).url).toBe(
      `${API}/conferenceRecords?pageSize=50`,
    );
  });

  it("get addresses one encoded conference record", async () => {
    expect((await request("google_meet_get", { conferenceRecordId: "rec/1" })).url).toBe(
      `${API}/conferenceRecords/rec%2F1`,
    );
  });

  it("quotes the API's status and body, and refuses without a token", async () => {
    serve({ status: 403, body: "PERMISSION_DENIED" });
    await withEnv({ GOOGLE_OAUTH_ACCESS_TOKEN: "t" }, async () => {
      await expect(tools.call("google_meet_list", {})).rejects.toThrow(
        "Google Meet API 403: PERMISSION_DENIED",
      );
    });

    const stub = serve();
    await withEnv({ GOOGLE_OAUTH_ACCESS_TOKEN: undefined }, async () => {
      await expect(tools.call("google_meet_search", {})).rejects.toThrow(
        "GOOGLE_OAUTH_ACCESS_TOKEN is not set",
      );
    });
    expect(stub.calls).toEqual([]);
  });
});
