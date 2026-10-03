import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  type CapturedTools,
  captureTools,
  type FetchStub,
  stubFetch,
} from "../../../scripts/connector-tool-harness.ts";
import { resetConnectorModeForTests, setConnectorMode } from "../../../shared/connector-mode.ts";
import { registerNotionTools } from "../src/tools.ts";

const TOKEN = "NOTION_ACCESS_TOKEN";

let tools: CapturedTools;
let fetchStub: FetchStub;

beforeEach(() => {
  resetConnectorModeForTests();
  setConnectorMode("gateway");
  process.env[TOKEN] = "secret_notion";
  fetchStub = stubFetch('{"results":[]}');
  tools = captureTools(registerNotionTools);
});

afterEach(() => {
  fetchStub.restore();
  delete process.env[TOKEN];
  resetConnectorModeForTests();
});

describe("notion requests", () => {
  it("a read carries the bearer token and the pinned Notion-Version, and no Content-Type", async () => {
    await tools.call("notion_block_children", { blockId: "b 1" });
    const req = fetchStub.only;
    expect(req.method).toBe("GET");
    expect(req.url).toBe("https://api.notion.com/v1/blocks/b%201/children?page_size=50");
    expect(req.headers).toEqual({
      authorization: "Bearer secret_notion",
      "notion-version": "2022-06-28",
    });
    expect(req.body).toBeUndefined();
  });

  it("a request with a body also declares it JSON", async () => {
    await tools.call("notion_page_list", { query: "roadmap" });
    const req = fetchStub.only;
    expect(req.method).toBe("POST");
    expect(req.url).toBe("https://api.notion.com/v1/search");
    expect(req.headers).toEqual({
      authorization: "Bearer secret_notion",
      "notion-version": "2022-06-28",
      "content-type": "application/json",
    });
    expect(req.body).toBe(
      '{"filter":{"property":"object","value":"page"},"page_size":50,"query":"roadmap"}',
    );
  });

  it("quotes Notion's status and body when a request fails", async () => {
    fetchStub.restore();
    fetchStub = stubFetch({ status: 401, body: '{"code":"unauthorized"}' });
    await expect(tools.call("notion_page_list", {})).rejects.toThrow(
      'Notion 401: {"code":"unauthorized"}',
    );
  });
});

describe("notion tool requests", () => {
  const API = "https://api.notion.com/v1";

  /** Replace the stub with one answering `reply`, and return it. */
  function serve(reply: Parameters<typeof stubFetch>[0]): FetchStub {
    fetchStub.restore();
    fetchStub = stubFetch(reply);
    return fetchStub;
  }

  function body(): unknown {
    return JSON.parse(fetchStub.only.body ?? "null") as unknown;
  }

  it("page_get reads the page and its direct children, and returns both", async () => {
    serve((req) => (req.url.includes("/children") ? '{"results":["b1"]}' : '{"id":"p 1"}'));
    expect(await tools.callJson("notion_page_get", { pageId: "p 1" })).toEqual({
      page: { id: "p 1" },
      blockChildren: { results: ["b1"] },
    });
    expect(fetchStub.calls.map((c) => c.url)).toEqual([
      `${API}/pages/p%201`,
      `${API}/blocks/p%201/children?page_size=100`,
    ]);
  });

  it("page_get names the children request when only that one fails", async () => {
    serve((req) =>
      req.url.includes("/children") ? { status: 404, body: "no children" } : '{"id":"p"}',
    );
    await expect(tools.call("notion_page_get", { pageId: "p" })).rejects.toThrow(
      "Notion blocks 404: no children",
    );
  });

  it("database_list searches databases with paging and an optional query", async () => {
    await tools.call("notion_database_list", { pageSize: 10, startCursor: "cur-1", query: "" });
    expect(fetchStub.only.url).toBe(`${API}/search`);
    // An empty query is not sent at all.
    expect(body()).toEqual({
      filter: { property: "object", value: "database" },
      page_size: 10,
      start_cursor: "cur-1",
    });
  });

  it("database_query POSTs to the encoded database with the page size", async () => {
    await tools.call("notion_database_query", { databaseId: "db/1" });
    expect(fetchStub.only.method).toBe("POST");
    expect(fetchStub.only.url).toBe(`${API}/databases/db%2F1/query`);
    expect(body()).toEqual({ page_size: 50 });

    serve('{"results":[]}');
    await tools.call("notion_database_query", { databaseId: "db", pageSize: 5, startCursor: "c" });
    expect(body()).toEqual({ page_size: 5, start_cursor: "c" });
  });

  it("block_children and comment_list page with a cursor when one is given", async () => {
    await tools.call("notion_block_children", { blockId: "b", pageSize: 3, startCursor: "c2" });
    expect(fetchStub.only.url).toBe(`${API}/blocks/b/children?page_size=3&start_cursor=c2`);

    serve('{"results":[]}');
    await tools.call("notion_comment_list", { blockId: "b 1" });
    expect(fetchStub.only.url).toBe(`${API}/comments?block_id=b+1&page_size=50`);

    serve('{"results":[]}');
    await tools.call("notion_comment_list", { blockId: "b", pageSize: 7, startCursor: "c3" });
    expect(fetchStub.only.url).toBe(`${API}/comments?block_id=b&page_size=7&start_cursor=c3`);

    serve('{"results":[]}');
    await tools.call("notion_block_children", { blockId: "b", startCursor: "" });
    expect(fetchStub.only.url).toBe(`${API}/blocks/b/children?page_size=50`);
  });

  it("page_create titles the page under its parent, truncating at 2000 characters", async () => {
    await tools.call("notion_page_create", { parentPageId: "parent", title: "x".repeat(2100) });
    expect(fetchStub.only.method).toBe("POST");
    expect(fetchStub.only.url).toBe(`${API}/pages`);
    expect(body()).toEqual({
      parent: { page_id: "parent" },
      properties: { title: { title: [{ type: "text", text: { content: "x".repeat(2000) } }] } },
    });
  });

  it("page_create writes the title under a custom property name", async () => {
    await tools.call("notion_page_create", {
      parentPageId: "parent",
      title: "Q4",
      titlePropertyName: "Name",
    });
    expect((body() as { properties: Record<string, unknown> }).properties).toEqual({
      Name: { title: [{ type: "text", text: { content: "Q4" } }] },
    });
  });

  it("kb_append creates a database page titled under Name, or a custom property", async () => {
    await tools.call("notion_kb_append", {
      databaseId: "kb-db",
      title: "Runbook",
      bodyMarkdown: "Restart the worker.",
      citationsJson: JSON.stringify([{ itemId: "i1", channelId: "c1", url: "https://x.test/1" }]),
    });
    const sent = body() as {
      parent: unknown;
      properties: Record<string, unknown>;
      children: unknown[];
    };
    expect(fetchStub.only.url).toBe(`${API}/pages`);
    expect(sent.parent).toEqual({ database_id: "kb-db" });
    expect(Object.keys(sent.properties)).toEqual(["Name"]);
    expect(JSON.stringify(sent.children)).toContain("Restart the worker.");

    serve('{"id":"p"}');
    await tools.call("notion_kb_append", {
      databaseId: "kb-db",
      title: "Runbook",
      bodyMarkdown: "Body",
      titlePropertyName: "Title",
    });
    expect(Object.keys((body() as { properties: Record<string, unknown> }).properties)).toEqual([
      "Title",
    ]);
  });

  it("page_update PATCHes the parsed properties object", async () => {
    await tools.call("notion_page_update", {
      pageId: "p/1",
      propertiesJson: '{"Status":{"select":{"name":"Done"}}}',
    });
    expect(fetchStub.only.method).toBe("PATCH");
    expect(fetchStub.only.url).toBe(`${API}/pages/p%2F1`);
    expect(body()).toEqual({ properties: { Status: { select: { name: "Done" } } } });
  });

  it("page_update refuses properties that are not a JSON object, before any request", async () => {
    for (const [json, message] of [
      ["{nope", "propertiesJson must be valid JSON"],
      ["[1,2]", "propertiesJson must be a JSON object"],
      ["null", "propertiesJson must be a JSON object"],
      ['"text"', "propertiesJson must be a JSON object"],
    ] as const) {
      await expect(
        tools.call("notion_page_update", { pageId: "p", propertiesJson: json }),
      ).rejects.toThrow(message);
    }
    expect(fetchStub.calls).toEqual([]);
  });

  it("block_append PATCHes the parsed children array", async () => {
    await tools.call("notion_block_append", {
      parentBlockId: "blk 1",
      childrenJson: '[{"type":"divider","divider":{}}]',
    });
    expect(fetchStub.only.method).toBe("PATCH");
    expect(fetchStub.only.url).toBe(`${API}/blocks/blk%201/children`);
    expect(body()).toEqual({ children: [{ type: "divider", divider: {} }] });
  });

  it("block_append refuses children that are not a JSON array, before any request", async () => {
    await expect(
      tools.call("notion_block_append", { parentBlockId: "b", childrenJson: "[oops" }),
    ).rejects.toThrow("childrenJson must be valid JSON");
    await expect(
      tools.call("notion_block_append", { parentBlockId: "b", childrenJson: '{"type":"x"}' }),
    ).rejects.toThrow("childrenJson must be a JSON array");
    expect(fetchStub.calls).toEqual([]);
  });

  it("comment_create starts a thread on the page", async () => {
    await tools.call("notion_comment_create", { pageId: "p", text: "Looks good" });
    expect(fetchStub.only.method).toBe("POST");
    expect(fetchStub.only.url).toBe(`${API}/comments`);
    expect(body()).toEqual({
      parent: { page_id: "p" },
      rich_text: [{ type: "text", text: { content: "Looks good" } }],
    });
  });

  it("refuses without NOTION_ACCESS_TOKEN, before any request", async () => {
    delete process.env[TOKEN];
    await expect(tools.call("notion_comment_list", { blockId: "b" })).rejects.toThrow(
      "NOTION_ACCESS_TOKEN is not set",
    );
    expect(fetchStub.calls).toEqual([]);
  });
});
