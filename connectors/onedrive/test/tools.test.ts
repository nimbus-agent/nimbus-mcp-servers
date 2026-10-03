import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  type ApprovedWrite,
  approvedStandaloneWrite,
  type CapturedTools,
  captureTools,
  type FetchStub,
  type RecordedRequest,
  type StubReply,
  stubFetch,
  withEnv,
} from "../../../scripts/connector-tool-harness.ts";
import { resetConnectorModeForTests, setConnectorMode } from "../../../shared/connector-mode.ts";
import { ONEDRIVE_TOOL_NAMES, registerOnedriveTools } from "../src/tools.ts";

const GRAPH = "https://graph.microsoft.com/v1.0";

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

/** Call `name` signed in; return the one request it made. */
async function request(name: string, args: Record<string, unknown>): Promise<RecordedRequest> {
  const stub = serve('{"value":[]}');
  await signedIn(async () => {
    await tools.call(name, args);
  });
  return stub.only;
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

describe("onedrive tools", () => {
  it("registers exactly ONEDRIVE_TOOL_NAMES, in order", () => {
    expect(tools.registrationOrder()).toEqual([...ONEDRIVE_TOOL_NAMES]);
  });

  it("item_list lists the drive root, 50 at a time, with the bearer token", async () => {
    const req = await request("onedrive_item_list", {});
    expect(req.url).toBe(`${GRAPH}/me/drive/root/children?$top=50`);
    expect(req.headers["authorization"]).toBe("Bearer ms-token");
  });

  it("item_list lists a folder's children by parent id", async () => {
    const req = await request("onedrive_item_list", { parentId: "A!1", pageSize: 10 });
    expect(req.url).toBe(`${GRAPH}/me/drive/items/A!1/children?$top=10`);
  });

  it("item_list follows a same-origin nextLink as given, ahead of every other argument", async () => {
    const next = `${GRAPH}/me/drive/root/children?$skiptoken=abc`;
    const req = await request("onedrive_item_list", { nextLink: next, parentId: "ignored" });
    expect(req.url).toBe(next);
  });

  it("item_list will not send the token to a nextLink on another host", async () => {
    const stub = serve("{}");
    await signedIn(async () => {
      await expect(
        tools.call("onedrive_item_list", { nextLink: "https://evil.example/steal?x=1" }),
      ).rejects.toThrow("refusing to fetch cross-origin URL");
    });
    expect(stub.calls).toEqual([]);
  });

  it("item_get reads one item's metadata", async () => {
    expect((await request("onedrive_item_get", { itemId: "id/1" })).url).toBe(
      `${GRAPH}/me/drive/items/id%2F1`,
    );
  });

  it("item_search escapes quotes in the query, and follows a nextLink when given", async () => {
    expect((await request("onedrive_item_search", { query: "o'brien notes" })).url).toBe(
      `${GRAPH}/me/drive/root/search(q='o''brien notes')?$top=25`,
    );
    expect((await request("onedrive_item_search", { query: "x", pageSize: 5 })).url).toBe(
      `${GRAPH}/me/drive/root/search(q='x')?$top=5`,
    );
    const next = `${GRAPH}/me/drive/root/search(q='x')?$skiptoken=2`;
    expect((await request("onedrive_item_search", { query: "x", nextLink: next })).url).toBe(next);
  });

  it("item_move PATCHes the new parent, and the new name when one is given", async () => {
    const moved = await request("onedrive_item_move", { itemId: "i1", newParentId: "p2" });
    expect(`${moved.method} ${moved.url}`).toBe(`PATCH ${GRAPH}/me/drive/items/i1`);
    expect(moved.headers["content-type"]).toBe("application/json");
    expect(JSON.parse(moved.body ?? "null")).toEqual({ parentReference: { id: "p2" } });

    const renamed = await request("onedrive_item_move", {
      itemId: "i1",
      newParentId: "p2",
      newName: "report.pdf",
    });
    expect(JSON.parse(renamed.body ?? "null")).toEqual({
      parentReference: { id: "p2" },
      name: "report.pdf",
    });
  });

  it("item_delete DELETEs the item and reports success on a 204", async () => {
    const stub = serve({ status: 204, body: "" });
    await signedIn(async () => {
      expect(await tools.callJson("onedrive_item_delete", { itemId: "i1" })).toEqual({ ok: true });
    });
    expect(`${stub.only.method} ${stub.only.url}`).toBe(`DELETE ${GRAPH}/me/drive/items/i1`);
  });

  it("item_delete quotes Graph's status and body when the delete is refused", async () => {
    serve({ status: 403, body: '{"error":{"code":"accessDenied"}}' });
    await signedIn(async () => {
      await expect(tools.call("onedrive_item_delete", { itemId: "i1" })).rejects.toThrow(
        'Graph 403: {"error":{"code":"accessDenied"}}',
      );
    });
  });

  it("item_delete, approved standalone, audits the item id as the pre-state it destroys", async () => {
    resetConnectorModeForTests();
    setConnectorMode("standalone");
    const stub = serve({ status: 204, body: "" });
    let run: ApprovedWrite | undefined;
    await signedIn(async () => {
      run = await approvedStandaloneWrite(
        registerOnedriveTools,
        { NIMBUS_MCP_ONEDRIVE_WRITE_SCOPE: "item:i1" },
        "onedrive_item_delete",
        { itemId: "i1" },
      );
    });
    expect(run?.answer).toEqual({ ok: true });
    expect(`${stub.only.method} ${stub.only.url}`).toBe(`DELETE ${GRAPH}/me/drive/items/i1`);
    expect(run?.audit.map((e) => e.outcome)).toEqual(["requested", "accepted", "executed"]);
    expect(run?.audit[2]?.detail["preState"]).toEqual({ itemId: "i1" });
    expect(run?.chain).toEqual({ ok: true, count: 3 });
  });

  it("refuses without MICROSOFT_OAUTH_ACCESS_TOKEN, before any request", async () => {
    const stub = serve("{}");
    await withEnv({ MICROSOFT_OAUTH_ACCESS_TOKEN: undefined }, async () => {
      await expect(tools.call("onedrive_item_get", { itemId: "i1" })).rejects.toThrow(
        "MICROSOFT_OAUTH_ACCESS_TOKEN is not set",
      );
      await expect(tools.call("onedrive_item_download", { itemId: "i1" })).rejects.toThrow(
        "MICROSOFT_OAUTH_ACCESS_TOKEN is not set",
      );
    });
    expect(stub.calls).toEqual([]);
  });
});

describe("onedrive_item_download", () => {
  const META = `${GRAPH}/me/drive/items/f1?$select=id,name,folder,file`;
  const CONTENT = `${GRAPH}/me/drive/items/f1/content`;

  /** Answer the metadata request with `meta` and the content request with `content`. */
  function drive(meta: StubReply, content: StubReply = "file body"): FetchStub {
    return serve((req) => {
      if (req.url === META) return meta;
      if (req.url === CONTENT) return content;
      return undefined;
    });
  }

  async function download(args: Record<string, unknown> = {}): Promise<unknown> {
    let out: unknown;
    await signedIn(async () => {
      out = await tools.callJson("onedrive_item_download", { itemId: "f1", ...args });
    });
    return out;
  }

  it("checks the item is a file, then returns its whole content as base64", async () => {
    const stub = drive('{"id":"f1","name":"a.txt","file":{}}', "hello, file");
    expect(await download()).toEqual({
      itemId: "f1",
      encoding: "base64",
      truncated: false,
      byteLength: 11,
      returnedBytes: 11,
      content: Buffer.from("hello, file").toString("base64"),
    });
    expect(stub.calls.map((c) => c.url)).toEqual([META, CONTENT]);
    expect(stub.calls[1]?.headers["authorization"]).toBe("Bearer ms-token");
  });

  it("returns only the first maxBytes of a larger file, and says it truncated", async () => {
    const body = "x".repeat(1024) + "y".repeat(976);
    drive('{"id":"f1","file":{}}', body);
    expect(await download({ maxBytes: 1024 })).toEqual({
      itemId: "f1",
      encoding: "base64",
      truncated: true,
      byteLength: 2000,
      returnedBytes: 1024,
      content: Buffer.from("x".repeat(1024)).toString("base64"),
    });
  });

  it("refuses a folder, and never asks for its content", async () => {
    const stub = drive('{"id":"f1","folder":{"childCount":3}}');
    await signedIn(async () => {
      await expect(tools.call("onedrive_item_download", { itemId: "f1" })).rejects.toThrow(
        "Item is a folder; download applies to files only",
      );
    });
    expect(stub.calls.map((c) => c.url)).toEqual([META]);
  });

  it("refuses metadata that is not an object", async () => {
    drive("[1,2]");
    await signedIn(async () => {
      await expect(tools.call("onedrive_item_download", { itemId: "f1" })).rejects.toThrow(
        "Invalid metadata response",
      );
    });
  });

  it("quotes Graph when the metadata or the content request fails", async () => {
    drive({ status: 404, body: "itemNotFound" });
    await signedIn(async () => {
      await expect(tools.call("onedrive_item_download", { itemId: "f1" })).rejects.toThrow(
        "Graph 404: itemNotFound",
      );
    });

    drive('{"id":"f1","file":{}}', { status: 503, body: "serviceNotAvailable" });
    await signedIn(async () => {
      await expect(tools.call("onedrive_item_download", { itemId: "f1" })).rejects.toThrow(
        "Graph 503: serviceNotAvailable",
      );
    });
  });
});
