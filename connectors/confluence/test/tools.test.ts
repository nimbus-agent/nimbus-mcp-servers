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
import { CONFLUENCE_TOOL_NAMES, registerConfluenceTools } from "../src/tools.ts";

const API = "https://acme.atlassian.net/wiki/rest/api";

let tools: CapturedTools;
let http: FetchStub | undefined;

function serve(reply: StubReply): FetchStub {
  http?.restore();
  http = stubFetch(reply);
  return http;
}

/** A Cloud site given without a scheme or the /wiki suffix, as users often paste it. */
function configured(fn: () => Promise<void>): Promise<void> {
  return withEnv(
    {
      CONFLUENCE_BASE_URL: "acme.atlassian.net/",
      CONFLUENCE_EMAIL: "ada@example.com",
      CONFLUENCE_API_TOKEN: "atl-token",
    },
    fn,
  );
}

/** Call `name`; return the one request it made. */
async function request(name: string, args: Record<string, unknown>): Promise<RecordedRequest> {
  const stub = serve('{"id":"1"}');
  await configured(async () => {
    expect(await tools.callJson(name, args)).toEqual({ id: "1" });
  });
  return stub.only;
}

// Gateway mode: the tool surface itself. Standalone scope targets are asserted in
// scripts/connector-write-scope.test.ts.
beforeEach(() => {
  resetConnectorModeForTests();
  setConnectorMode("gateway");
  tools = captureTools(registerConfluenceTools);
});

afterEach(() => {
  http?.restore();
  http = undefined;
  resetConnectorModeForTests();
});

describe("confluence reads", () => {
  it("registers exactly CONFLUENCE_TOOL_NAMES, in order", () => {
    expect(tools.registrationOrder()).toEqual([...CONFLUENCE_TOOL_NAMES]);
  });

  it("authenticates with Basic email:token against the site's /wiki REST API", async () => {
    const req = await request("confluence_space_list", {});
    expect(req.url).toBe(`${API}/space?limit=25&start=0`);
    expect(req.headers["authorization"]).toBe(
      `Basic ${Buffer.from("ada@example.com:atl-token").toString("base64")}`,
    );
  });

  it("keeps a base URL that already ends in /wiki as it is", async () => {
    const stub = serve("{}");
    await withEnv(
      {
        CONFLUENCE_BASE_URL: "https://wiki.example.com/wiki",
        CONFLUENCE_EMAIL: "e",
        CONFLUENCE_API_TOKEN: "t",
      },
      async () => {
        await tools.call("confluence_space_list", { limit: 5, start: 10 });
      },
    );
    expect(stub.only.url).toBe("https://wiki.example.com/wiki/rest/api/space?limit=5&start=10");
  });

  const READS: readonly [string, Record<string, unknown>, string][] = [
    [
      "confluence_page_list",
      { spaceKey: "ENG" },
      "/content?type=page&spaceKey=ENG&limit=50&start=0&expand=history.lastUpdated%2Cversion",
    ],
    [
      "confluence_blogpost_list",
      { spaceKey: "ENG", limit: 3, start: 6 },
      "/content?type=blogpost&spaceKey=ENG&limit=3&start=6&expand=history.lastUpdated%2Cversion",
    ],
    [
      "confluence_page_get",
      { pageId: "12/3" },
      "/content/12%2F3?expand=body.storage,version,history.lastUpdated,space",
    ],
    [
      "confluence_blogpost_get",
      { postId: "77" },
      "/content/77?expand=body.storage,version,history.lastUpdated,space",
    ],
    [
      "confluence_comment_list",
      { pageId: "12" },
      "/content/12/child/comment?limit=50&start=0&expand=body.storage%2Cversion",
    ],
  ];

  for (const [name, args, path] of READS) {
    it(`${name} ${JSON.stringify(args)} GETs ${path.split("?")[0]}`, async () => {
      const req = await request(name, args);
      expect(`${req.method} ${req.url}`).toBe(`GET ${API}${path}`);
    });
  }

  it("refuses without CONFLUENCE_API_TOKEN, before any request, and quotes a failure", async () => {
    const stub = serve("{}");
    await withEnv(
      {
        CONFLUENCE_BASE_URL: "acme.atlassian.net",
        CONFLUENCE_EMAIL: "e",
        CONFLUENCE_API_TOKEN: "",
      },
      async () => {
        await expect(tools.call("confluence_space_list", {})).rejects.toThrow(
          "CONFLUENCE_API_TOKEN is not set",
        );
      },
    );
    expect(stub.calls).toEqual([]);

    serve({ status: 404, body: "No content found with id 9" });
    await configured(async () => {
      await expect(tools.call("confluence_page_get", { pageId: "9" })).rejects.toThrow(
        "Confluence 404: No content found with id 9",
      );
    });
  });
});

describe("confluence writes (gateway mode)", () => {
  it("page_create POSTs a storage-format page, under a parent only when one is given", async () => {
    const plain = await request("confluence_page_create", {
      spaceKey: "ENG",
      title: "Runbook",
      storageHtml: "<p>hi</p>",
    });
    expect(`${plain.method} ${plain.url}`).toBe(`POST ${API}/content`);
    expect(JSON.parse(plain.body ?? "null")).toEqual({
      type: "page",
      title: "Runbook",
      space: { key: "ENG" },
      body: { storage: { value: "<p>hi</p>", representation: "storage" } },
    });

    const child = await request("confluence_page_create", {
      spaceKey: "ENG",
      title: "Runbook",
      storageHtml: "<p>hi</p>",
      parentPageId: "500",
    });
    expect((JSON.parse(child.body ?? "null") as { ancestors?: unknown }).ancestors).toEqual([
      { id: "500" },
    ]);
  });

  it("page_update PUTs the next version number", async () => {
    const req = await request("confluence_page_update", {
      pageId: "12/3",
      versionNumber: 4,
      title: "Runbook",
      storageHtml: "<p>v5</p>",
    });
    expect(`${req.method} ${req.url}`).toBe(`PUT ${API}/content/12%2F3`);
    expect(JSON.parse(req.body ?? "null")).toEqual({
      type: "page",
      title: "Runbook",
      version: { number: 5, message: "nimbus" },
      body: { storage: { value: "<p>v5</p>", representation: "storage" } },
    });
  });

  it("comment_add POSTs a footer comment contained by the page", async () => {
    const req = await request("confluence_comment_add", { pageId: "12", storageHtml: "<p>+1</p>" });
    expect(`${req.method} ${req.url}`).toBe(`POST ${API}/content/12/child/comment`);
    expect(JSON.parse(req.body ?? "null")).toEqual({
      type: "comment",
      container: { id: "12", type: "page" },
      body: { storage: { value: "<p>+1</p>", representation: "storage" } },
    });
  });

  it("kb_append POSTs a page under the given parent, with no citations by default", async () => {
    const req = await request("confluence_kb_append", {
      spaceKey: "ENG",
      parentPageId: "500",
      title: "Decision: adopt Bun",
      bodyMarkdown: "We adopted Bun.",
    });
    expect(`${req.method} ${req.url}`).toBe(`POST ${API}/content`);
    const body = JSON.parse(req.body ?? "null") as {
      type: string;
      title: string;
      space: unknown;
      ancestors: unknown;
    };
    expect([body.type, body.title, body.space, body.ancestors]).toEqual([
      "page",
      "Decision: adopt Bun",
      { key: "ENG" },
      [{ id: "500" }],
    ]);
  });
});
