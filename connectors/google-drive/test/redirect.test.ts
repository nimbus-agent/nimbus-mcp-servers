import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  type CapturedTools,
  captureTools,
  type FetchStub,
  stubFetch,
} from "../../../scripts/connector-tool-harness.ts";
import { resetConnectorModeForTests, setConnectorMode } from "../../../shared/connector-mode.ts";
import { registerGoogleDriveTools } from "../src/tools.ts";

const TOKEN = "GOOGLE_OAUTH_ACCESS_TOKEN";
const FILES = "https://www.googleapis.com/drive/v3/files";
const META = `${FILES}/f1?fields=id%2Cname%2CmimeType%2Csize%2CwebViewLink`;
const MEDIA = `${FILES}/f1?alt=media`;
const SIGNED = "https://download.example-storage.net/blob/f1?sig=abc";
const EVIL = "https://evil.example/steal";

let tools: CapturedTools;
let stub: FetchStub | undefined;

beforeEach(() => {
  resetConnectorModeForTests();
  setConnectorMode("gateway");
  process.env[TOKEN] = "ya29.token";
  tools = captureTools(registerGoogleDriveTools);
});

afterEach(() => {
  stub?.restore();
  stub = undefined;
  delete process.env[TOKEN];
  resetConnectorModeForTests();
});

const meta = (mimeType: string): string =>
  JSON.stringify({ id: "f1", name: "n", mimeType, size: "5" });

describe("google-drive never sends its credential across a redirect", () => {
  it("a read refuses a redirect to another origin and sends nothing there", async () => {
    stub = stubFetch({ status: 302, headers: { location: EVIL } });
    await expect(tools.call("gdrive_file_list", {})).rejects.toThrow(
      "Google Drive redirected to another origin; refused",
    );
    expect(stub.calls).toHaveLength(1);
    expect(stub.only.redirect).toBe("manual");
  });

  it("a write refuses a 3xx instead of replaying it", async () => {
    stub = stubFetch({ status: 307, headers: { location: `${FILES}/f1` } });
    await expect(tools.call("gdrive_file_rename", { fileId: "f1", newName: "x" })).rejects.toThrow(
      "Google Drive answered a PATCH with a redirect (307)",
    );
    expect(stub.calls).toHaveLength(1);
  });

  it("a create refuses a 3xx on both the metadata and the multipart upload", async () => {
    stub = stubFetch({ status: 308, headers: { location: FILES } });
    await expect(tools.call("gdrive_file_create", { name: "n" })).rejects.toThrow(
      "Google Drive answered a POST with a redirect (308)",
    );
    await expect(tools.call("gdrive_file_create", { name: "n", content: "c" })).rejects.toThrow(
      "Google Drive answered a POST with a redirect (308)",
    );
    expect(stub.calls).toHaveLength(2);
  });

  it("a media download that hands off to signed storage fetches it WITHOUT the token", async () => {
    stub = stubFetch((req) => {
      if (req.url === META) return meta("text/plain");
      if (req.url === MEDIA) return { status: 302, headers: { location: SIGNED } };
      if (req.url === SIGNED) return "hello";
      return undefined;
    });
    const out = (await tools.callJson("gdrive_file_download", { fileId: "f1" })) as {
      content: string;
    };
    expect(out.content).toBe("hello");
    expect(stub.calls.map((c) => c.url)).toEqual([META, MEDIA, SIGNED]);
    expect(stub.calls[1]?.headers["authorization"]).toBe("Bearer ya29.token");
    expect(stub.calls[2]?.headers["authorization"]).toBeUndefined();
    expect(JSON.stringify(stub.calls[2]?.headers)).not.toContain("ya29.token");
  });

  it("refuses a hand-off to a non-https URL, sending nothing there", async () => {
    stub = stubFetch((req) =>
      req.url === MEDIA
        ? { status: 302, headers: { location: "http://download.example-storage.net/f1" } }
        : meta("text/plain"),
    );
    await expect(tools.call("gdrive_file_download", { fileId: "f1" })).rejects.toThrow(
      "Google Drive redirected the download to a http: URL; refused",
    );
    expect(stub.calls.map((c) => c.url)).toEqual([META, MEDIA]);
  });

  it("a Workspace export refuses a redirect to another origin", async () => {
    stub = stubFetch((req) =>
      req.url.includes("/export?")
        ? { status: 302, headers: { location: EVIL } }
        : meta("application/vnd.google-apps.document"),
    );
    await expect(tools.call("gdrive_file_download", { fileId: "f1" })).rejects.toThrow(
      "Google Drive redirected to another origin; refused",
    );
    expect(stub.calls).toHaveLength(2);
  });
});
