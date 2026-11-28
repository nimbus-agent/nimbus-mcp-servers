import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  type CapturedTools,
  captureTools,
  type FetchStub,
  stubFetch,
} from "../../../scripts/connector-tool-harness.ts";
import { registerGooglePhotosTools } from "../src/tools.ts";

const TOKEN = "GOOGLE_OAUTH_ACCESS_TOKEN";
const SEARCH_URL = "https://photoslibrary.googleapis.com/v1/mediaItems:search";

let tools: CapturedTools;
let stub: FetchStub | undefined;

beforeEach(() => {
  process.env[TOKEN] = "ya29.photos";
  tools = captureTools(registerGooglePhotosTools);
});

afterEach(() => {
  stub?.restore();
  stub = undefined;
  delete process.env[TOKEN];
});

describe("google photos never sends its token across a redirect", () => {
  it("a GET read refuses a redirect to another origin and sends nothing there", async () => {
    stub = stubFetch({ status: 302, headers: { location: "https://evil.example/steal" } });
    await expect(tools.call("gphotos_album_list", {})).rejects.toThrow(
      "Google Photos redirected to another origin; refused",
    );
    expect(stub.calls).toHaveLength(1);
    expect(stub.only.redirect).toBe("manual");
  });

  it("the mediaItems:search POST refuses a 3xx instead of replaying it", async () => {
    stub = stubFetch({ status: 307, headers: { location: SEARCH_URL } });
    await expect(tools.call("gphotos_media_list", {})).rejects.toThrow(
      "Google Photos answered a POST with a redirect (307); refused (a read: nothing was written)",
    );
    expect(stub.calls.map((c) => c.url)).toEqual([SEARCH_URL]);
  });
});
