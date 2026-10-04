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
let fetchStub: FetchStub;

beforeEach(() => {
  process.env[TOKEN] = "ya29.photos";
  fetchStub = stubFetch('{"mediaItems":[]}');
  tools = captureTools(registerGooglePhotosTools);
});

afterEach(() => {
  fetchStub.restore();
  delete process.env[TOKEN];
});

/** The one request a tool call made: its URL, method and raw body. */
async function searchRequest(
  name: string,
  args: Record<string, unknown>,
): Promise<{ url: string; method: string; body: string | undefined }> {
  await tools.call(name, args);
  const { url, method, body } = fetchStub.only;
  return { url, method, body };
}

describe("google photos media tools POST one mediaItems:search body", () => {
  for (const name of ["gphotos_media_list", "gphotos_media_search"]) {
    it(`${name}: page size 50 by default, nothing else`, async () => {
      expect(await searchRequest(name, {})).toEqual({
        url: SEARCH_URL,
        method: "POST",
        body: '{"pageSize":50}',
      });
    });

    it(`${name}: page size, page token, then album`, async () => {
      expect(
        await searchRequest(name, { pageSize: 10, pageToken: "next", albumId: "alb-1" }),
      ).toEqual({
        url: SEARCH_URL,
        method: "POST",
        body: '{"pageSize":10,"pageToken":"next","albumId":"alb-1"}',
      });
    });

    it(`${name}: an empty page token is left out`, async () => {
      expect((await searchRequest(name, { pageToken: "" })).body).toBe('{"pageSize":50}');
    });
  }

  it("gphotos_media_search adds only the filters that were switched on, last", async () => {
    expect(
      (
        await searchRequest("gphotos_media_search", {
          albumId: "alb-1",
          includeArchivedMedia: true,
          excludeNonAppCreatedData: false,
        })
      ).body,
    ).toBe('{"pageSize":50,"albumId":"alb-1","filters":{"includeArchivedMedia":true}}');
  });

  it("gphotos_media_search can switch on both filters, in a stable order", async () => {
    expect(
      (
        await searchRequest("gphotos_media_search", {
          includeArchivedMedia: true,
          excludeNonAppCreatedData: true,
        })
      ).body,
    ).toBe(
      '{"pageSize":50,"filters":{"includeArchivedMedia":true,"excludeNonAppCreatedData":true}}',
    );
  });

  it("gphotos_media_search sends no filters object when none is on", async () => {
    expect(
      (
        await searchRequest("gphotos_media_search", {
          includeArchivedMedia: false,
          excludeNonAppCreatedData: false,
        })
      ).body,
    ).toBe('{"pageSize":50}');
  });

  it("carries the bearer token", async () => {
    await tools.call("gphotos_media_list", {});
    expect(fetchStub.only.headers["authorization"]).toBe("Bearer ya29.photos");
  });
});

describe("google photos album tools", () => {
  const API = "https://photoslibrary.googleapis.com/v1";

  async function urlOf(name: string, args: Record<string, unknown>): Promise<string> {
    await tools.call(name, args);
    return fetchStub.only.url;
  }

  it("album_list asks for 25 albums once under the API base", async () => {
    expect(await urlOf("gphotos_album_list", {})).toBe(`${API}/albums?pageSize=25`);
  });

  it("album_list pages by size and token, and drops an empty token", async () => {
    expect(await urlOf("gphotos_album_list", { pageSize: 50, pageToken: "next" })).toBe(
      `${API}/albums?pageSize=50&pageToken=next`,
    );
    fetchStub.calls.length = 0;
    expect(await urlOf("gphotos_album_list", { pageToken: "" })).toBe(`${API}/albums?pageSize=25`);
  });

  it("album_get addresses one encoded album", async () => {
    expect(await urlOf("gphotos_album_get", { albumId: "a/1" })).toBe(`${API}/albums/a%2F1`);
  });
});
