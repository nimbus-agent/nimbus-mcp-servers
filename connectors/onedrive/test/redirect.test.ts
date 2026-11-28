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
import { resetConnectorModeForTests, setConnectorMode } from "../../../shared/connector-mode.ts";
import { registerOnedriveTools } from "../src/tools.ts";

const GRAPH = "https://graph.microsoft.com/v1.0";
const META = `${GRAPH}/me/drive/items/f1?$select=id,name,folder,file`;
const CONTENT = `${GRAPH}/me/drive/items/f1/content`;
const SIGNED = "https://contoso-my.sharepoint.example/download?tempauth=abc";
const FILE_META = '{"id":"f1","name":"a.txt","file":{}}';

let tools: CapturedTools;
let http: FetchStub | undefined;

function serve(reply: StubReply | ((req: RecordedRequest) => StubReply | undefined)): FetchStub {
  http?.restore();
  http = stubFetch(reply);
  return http;
}

function signedIn(fn: () => Promise<void>): Promise<void> {
  return withEnv({ MICROSOFT_OAUTH_ACCESS_TOKEN: "ms-token" }, fn);
}

beforeEach(() => {
  resetConnectorModeForTests();
  setConnectorMode("gateway");
  tools = captureTools(registerOnedriveTools);
});

afterEach(() => {
  http?.restore();
  http = undefined;
  resetConnectorModeForTests();
});

describe("onedrive never sends its credential across a redirect", () => {
  it("a read refuses a redirect to another origin and sends nothing there", async () => {
    const stub = serve({ status: 302, headers: { location: "https://evil.example/steal" } });
    await signedIn(async () => {
      await expect(tools.call("onedrive_item_search", { query: "q" })).rejects.toThrow(
        "Graph redirected to another origin; refused",
      );
    });
    expect(stub.calls).toHaveLength(1);
    expect(stub.only.redirect).toBe("manual");
  });

  it("a write refuses a 3xx instead of replaying it", async () => {
    const stub = serve({ status: 307, headers: { location: `${GRAPH}/me/drive/items/i1` } });
    await signedIn(async () => {
      await expect(tools.call("onedrive_item_delete", { itemId: "i1" })).rejects.toThrow(
        "Graph answered a DELETE with a redirect (307)",
      );
    });
    expect(stub.calls).toHaveLength(1);
  });

  it("a download that hands off to a signed URL fetches it WITHOUT the token", async () => {
    const stub = serve((req) => {
      if (req.url === META) return FILE_META;
      if (req.url === CONTENT) return { status: 302, headers: { location: SIGNED } };
      if (req.url === SIGNED) return "signed bytes";
      return undefined;
    });
    await signedIn(async () => {
      expect(await tools.callJson("onedrive_item_download", { itemId: "f1" })).toMatchObject({
        byteLength: 12,
        content: Buffer.from("signed bytes").toString("base64"),
      });
    });
    expect(stub.calls.map((c) => c.url)).toEqual([META, CONTENT, SIGNED]);
    expect(stub.calls[1]?.headers["authorization"]).toBe("Bearer ms-token");
    expect(stub.calls[2]?.headers["authorization"]).toBeUndefined();
    expect(JSON.stringify(stub.calls[2]?.headers)).not.toContain("ms-token");
  });

  it("refuses a hand-off to a non-https URL, sending nothing there", async () => {
    const stub = serve((req) =>
      req.url === CONTENT
        ? { status: 302, headers: { location: "file:///etc/passwd" } }
        : FILE_META,
    );
    await signedIn(async () => {
      await expect(tools.call("onedrive_item_download", { itemId: "f1" })).rejects.toThrow(
        "Graph redirected the download to a file: URL; refused",
      );
    });
    expect(stub.calls.map((c) => c.url)).toEqual([META, CONTENT]);
  });
});
