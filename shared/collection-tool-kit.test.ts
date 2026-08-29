import { describe, expect, it } from "bun:test";
import { byToolName, captureTools } from "../scripts/connector-tool-harness.ts";
import {
  type CollectionToolsConfig,
  collectionToolNames,
  DEFAULT_SEARCH_MAX,
  envelopeRows,
  identityRows,
  registerCollectionTools,
} from "./collection-tool-kit.ts";

/** Records every path the tools ask for and replies with a canned body. */
function recordingGetter(body: unknown): {
  get: (path: string) => Promise<unknown>;
  paths: string[];
} {
  const paths: string[] = [];
  return {
    paths,
    get: (path: string): Promise<unknown> => {
      paths.push(path);
      return Promise.resolve(body);
    },
  };
}

const passthroughFilter = (rows: readonly unknown[]): readonly unknown[] => rows;

function config(overrides: Partial<CollectionToolsConfig> = {}): CollectionToolsConfig {
  return {
    prefix: "thing",
    get: () => Promise.resolve({}),
    list: { path: "/things", description: "List things." },
    item: { path: (id) => `/things/${id}`, description: "Get one thing." },
    search: {
      description: "Search things.",
      rows: envelopeRows("results"),
      filter: passthroughFilter,
    },
    ...overrides,
  };
}

describe("envelopeRows", () => {
  it("reads the named key", () => {
    expect(envelopeRows("results")({ results: [1, 2] })).toEqual([1, 2]);
  });

  it("returns undefined for a missing key, a null body, or a non-object", () => {
    expect(envelopeRows("results")({})).toBeUndefined();
    expect(envelopeRows("results")(null)).toBeUndefined();
  });
});

describe("identityRows", () => {
  it("returns the response itself", () => {
    expect(identityRows([1, 2])).toEqual([1, 2]);
  });
});

describe("collectionToolNames", () => {
  it("names the full triple by default", () => {
    expect(collectionToolNames(config())).toEqual(["thing_list", "thing_get", "thing_search"]);
  });

  it("honours per-tool name overrides", () => {
    expect(
      collectionToolNames(
        config({
          list: { path: "/books", description: "d", tool: "books_list" },
          item: { path: (id) => `/books/${id}`, description: "d", tool: "book_get" },
          search: {
            description: "d",
            rows: identityRows,
            filter: passthroughFilter,
            tool: "books_search",
          },
        }),
      ),
    ).toEqual(["thing_books_list", "thing_book_get", "thing_books_search"]);
  });

  it("omits the tools that were not configured", () => {
    const listOnly = { prefix: "thing", get: config().get, list: config().list };
    expect(collectionToolNames(listOnly)).toEqual(["thing_list"]);
  });
});

describe("registerCollectionTools", () => {
  it("registers exactly the names collectionToolNames predicts", () => {
    const cfg = config();
    const tools = captureTools((reg) => {
      registerCollectionTools(reg, cfg);
    });
    expect(tools.names()).toEqual(collectionToolNames(cfg).sort(byToolName));
  });

  it("passes each connector's own description through unchanged", () => {
    const tools = captureTools((reg) => {
      registerCollectionTools(reg, config());
    });
    expect(tools.get("thing_list").description).toBe("List things.");
    expect(tools.get("thing_get").description).toBe("Get one thing.");
    expect(tools.get("thing_search").description).toBe("Search things.");
  });

  describe("list", () => {
    it("GETs the list path and returns the body verbatim", async () => {
      const api = recordingGetter({ results: [{ id: 1 }], next: "cursor" });
      const tools = captureTools((reg) => {
        registerCollectionTools(reg, config({ get: api.get }));
      });
      expect(await tools.callJson("thing_list")).toEqual({ results: [{ id: 1 }], next: "cursor" });
      expect(api.paths).toEqual(["/things"]);
    });
  });

  describe("get", () => {
    it("builds the item path from the id", async () => {
      const api = recordingGetter({ id: 5 });
      const tools = captureTools((reg) => {
        registerCollectionTools(reg, config({ get: api.get }));
      });
      expect(await tools.callJson("thing_get", { id: "5" })).toEqual({ id: 5 });
      expect(api.paths).toEqual(["/things/5"]);
    });

    it("percent-encodes the id before the connector's path builder sees it", async () => {
      const api = recordingGetter({});
      const tools = captureTools((reg) => {
        registerCollectionTools(reg, config({ get: api.get }));
      });
      await tools.call("thing_get", { id: "a b/../c" });
      expect(api.paths).toEqual(["/things/a%20b%2F..%2Fc"]);
    });
  });

  describe("search", () => {
    it("filters the rows the accessor finds and returns a matches envelope", async () => {
      const api = recordingGetter({ results: [{ id: 1 }, { id: 2 }] });
      const tools = captureTools((reg) => {
        registerCollectionTools(
          reg,
          config({
            get: api.get,
            search: {
              description: "d",
              rows: envelopeRows("results"),
              filter: (rows) => rows.slice(0, 1),
            },
          }),
        );
      });
      expect(await tools.callJson("thing_search", { query: "q" })).toEqual({
        matches: [{ id: 1 }],
      });
    });

    it("returns no matches when the envelope key is missing", async () => {
      const api = recordingGetter({ detail: "nothing here" });
      const tools = captureTools((reg) => {
        registerCollectionTools(reg, config({ get: api.get }));
      });
      expect(await tools.callJson("thing_search", { query: "q" })).toEqual({ matches: [] });
    });

    it("searches the list path by default and a dedicated path when given", async () => {
      const api = recordingGetter({ results: [] });
      const tools = captureTools((reg) => {
        registerCollectionTools(reg, config({ get: api.get }));
      });
      await tools.call("thing_search", { query: "q" });
      expect(api.paths).toEqual(["/things"]);

      const api2 = recordingGetter({ results: [] });
      const tools2 = captureTools((reg) => {
        registerCollectionTools(
          reg,
          config({
            get: api2.get,
            search: {
              path: "/things/search",
              description: "d",
              rows: envelopeRows("results"),
              filter: passthroughFilter,
            },
          }),
        );
      });
      await tools2.call("thing_search", { query: "q" });
      expect(api2.paths).toEqual(["/things/search"]);
    });

    it("caps `limit` at the connector's maximum", () => {
      const tools = captureTools((reg) => {
        registerCollectionTools(reg, config());
      });
      const schema = tools.get("thing_search").schema as {
        safeParse: (v: unknown) => { success: boolean };
      };
      expect(schema.safeParse({ query: "q", limit: DEFAULT_SEARCH_MAX }).success).toBe(true);
      expect(schema.safeParse({ query: "q", limit: DEFAULT_SEARCH_MAX + 1 }).success).toBe(false);
      expect(schema.safeParse({ query: "" }).success).toBe(false);
    });

    it("honours a connector-specific maximum", () => {
      const tools = captureTools((reg) => {
        registerCollectionTools(
          reg,
          config({
            search: {
              description: "d",
              rows: identityRows,
              filter: passthroughFilter,
              maxLimit: 500,
            },
          }),
        );
      });
      const schema = tools.get("thing_search").schema as {
        safeParse: (v: unknown) => { success: boolean };
      };
      expect(schema.safeParse({ query: "q", limit: 500 }).success).toBe(true);
      expect(schema.safeParse({ query: "q", limit: 501 }).success).toBe(false);
    });
  });

  it("registers a list-only collection without get or search", async () => {
    const api = recordingGetter([1, 2]);
    const tools = captureTools((reg) => {
      registerCollectionTools(reg, {
        prefix: "thing",
        get: api.get,
        list: { path: "/things", description: "d" },
      });
    });
    expect(tools.names()).toEqual(["thing_list"]);
    expect(await tools.callJson("thing_list")).toEqual([1, 2]);
  });
});
