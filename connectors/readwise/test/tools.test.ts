import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  type CapturedTools,
  captureTools,
  type FetchStub,
  stubFetch,
  withEnv,
} from "../../../scripts/connector-tool-harness.ts";
import { READWISE_TOOL_NAMES, registerReadwiseTools } from "../src/tools.ts";

const TOKEN = "READWISE_TOKEN";

describe("readwise tools", () => {
  let tools: CapturedTools;
  let fetchStub: FetchStub | undefined;

  beforeEach(() => {
    tools = captureTools(registerReadwiseTools);
  });

  afterEach(() => {
    fetchStub?.restore();
    fetchStub = undefined;
  });

  function reply(body: unknown, status = 200): void {
    fetchStub = stubFetch({ body: JSON.stringify(body), status });
  }

  it("registers exactly the tools it declares", () => {
    expect(tools.names()).toEqual([...READWISE_TOOL_NAMES].sort());
  });

  it("refuses every tool when READWISE_TOKEN is unset", async () => {
    reply({});
    await withEnv({ [TOKEN]: undefined }, async () => {
      for (const name of READWISE_TOOL_NAMES) {
        await expect(tools.call(name, { id: "1", query: "q" })).rejects.toThrow(
          "READWISE_TOKEN is not set",
        );
      }
    });
    // Nothing was requested — the token check runs before the fetch.
    expect(fetchStub?.calls).toHaveLength(0);
  });

  it("authenticates with the Token scheme Readwise requires, not Bearer", async () => {
    reply({ results: [] });
    await withEnv({ [TOKEN]: "k1" }, async () => {
      await tools.call("readwise_list");
    });
    expect(fetchStub?.only.headers["authorization"]).toBe("Token k1");
    expect(fetchStub?.only.headers["accept"]).toBe("application/json");
  });

  describe("readwise_list", () => {
    it("requests the first page of highlights and returns the envelope verbatim", async () => {
      const envelope = { count: 2, next: null, previous: null, results: [{ id: 1 }, { id: 2 }] };
      reply(envelope);
      await withEnv({ [TOKEN]: "k" }, async () => {
        expect(await tools.callJson("readwise_list")).toEqual(envelope);
      });
      expect(fetchStub?.only.url).toBe("https://readwise.io/api/v2/highlights/?page_size=1000");
    });

    it("surfaces the status and body when Readwise rejects the call", async () => {
      reply({ detail: "Invalid token." }, 401);
      await withEnv({ [TOKEN]: "bad" }, async () => {
        await expect(tools.call("readwise_list")).rejects.toThrow(
          'Readwise 401: {"detail":"Invalid token."}',
        );
      });
    });
  });

  describe("readwise_get", () => {
    it("fetches one highlight by id", async () => {
      reply({ id: 7, text: "a highlight" });
      await withEnv({ [TOKEN]: "k" }, async () => {
        expect(await tools.callJson("readwise_get", { id: "7" })).toEqual({
          id: 7,
          text: "a highlight",
        });
      });
      expect(fetchStub?.only.url).toBe("https://readwise.io/api/v2/highlights/7/");
    });

    it("percent-encodes the id rather than letting it alter the path", async () => {
      reply({});
      await withEnv({ [TOKEN]: "k" }, async () => {
        await tools.call("readwise_get", { id: "../books/9" });
      });
      expect(fetchStub?.only.url).toBe("https://readwise.io/api/v2/highlights/..%2Fbooks%2F9/");
    });
  });

  describe("readwise_search", () => {
    it("filters the first page and returns a matches envelope", async () => {
      reply({
        results: [
          { id: 1, text: "on distributed systems", tags: [] },
          { id: 2, text: "about gardening", tags: [] },
        ],
      });
      await withEnv({ [TOKEN]: "k" }, async () => {
        const out = (await tools.callJson("readwise_search", { query: "distributed" })) as {
          matches: { id: number }[];
        };
        expect(out.matches.map((m) => m.id)).toEqual([1]);
      });
    });

    it("tolerates a response with no results array", async () => {
      reply({ detail: "empty" });
      await withEnv({ [TOKEN]: "k" }, async () => {
        expect(await tools.callJson("readwise_search", { query: "x" })).toEqual({ matches: [] });
      });
    });
  });

  describe("readwise_books_list", () => {
    it("requests the books collection, not the highlights one", async () => {
      reply({ results: [] });
      await withEnv({ [TOKEN]: "k" }, async () => {
        await tools.call("readwise_books_list");
      });
      expect(fetchStub?.only.url).toBe("https://readwise.io/api/v2/books/?page_size=1000");
    });
  });

  describe("readwise_book_get", () => {
    it("fetches one book by its own id space", async () => {
      reply({ id: 42, title: "A Book" });
      await withEnv({ [TOKEN]: "k" }, async () => {
        expect(await tools.callJson("readwise_book_get", { id: "42" })).toEqual({
          id: 42,
          title: "A Book",
        });
      });
      expect(fetchStub?.only.url).toBe("https://readwise.io/api/v2/books/42/");
    });
  });

  describe("readwise_books_search", () => {
    it("filters books by title/author and returns a matches envelope", async () => {
      reply({
        results: [
          { id: 1, title: "Designing Data-Intensive Applications", author: "Kleppmann" },
          { id: 2, title: "The Pragmatic Programmer", author: "Hunt" },
        ],
      });
      await withEnv({ [TOKEN]: "k" }, async () => {
        const out = (await tools.callJson("readwise_books_search", { query: "kleppmann" })) as {
          matches: { id: number }[];
        };
        expect(out.matches.map((m) => m.id)).toEqual([1]);
      });
      expect(fetchStub?.only.url).toBe("https://readwise.io/api/v2/books/?page_size=1000");
    });
  });
});
