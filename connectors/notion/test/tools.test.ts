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
