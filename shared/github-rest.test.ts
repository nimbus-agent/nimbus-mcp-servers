import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  GH_ACCEPT,
  GH_API,
  GH_API_VERSION,
  GH_HEADERS,
  ghFetch,
  ghRepoPath,
} from "./github-rest.ts";

let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("ghRepoPath", () => {
  it("builds /repos/<owner>/<repo>", () => {
    expect(ghRepoPath("nimbus-agent", "nimbus")).toBe("/repos/nimbus-agent/nimbus");
  });

  it("encodes each segment, so neither can add path components", () => {
    expect(ghRepoPath("a/b", "c?d")).toBe("/repos/a%2Fb/c%3Fd");
  });
});

describe("GH_HEADERS", () => {
  it("is exactly the media type and the pinned API version", () => {
    expect(GH_HEADERS).toEqual({ Accept: GH_ACCEPT, "X-GitHub-Api-Version": GH_API_VERSION });
  });
});

describe("ghFetch", () => {
  it("sends a Bearer token and the GitHub headers to the API base", async () => {
    const calls: Request[] = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      calls.push(new Request(typeof input === "string" ? input : String(input), init));
      return new Response('{"full_name":"o/r"}', { status: 200 });
    }) as typeof globalThis.fetch;

    const res = await ghFetch("ghp_tok", ghRepoPath("o", "r"));

    expect(res).toEqual({
      ok: true,
      status: 200,
      json: { full_name: "o/r" },
      text: '{"full_name":"o/r"}',
    });
    expect(calls[0]?.url).toBe(`${GH_API}/repos/o/r`);
    expect(calls[0]?.headers.get("authorization")).toBe("Bearer ghp_tok");
    expect(calls[0]?.headers.get("accept")).toBe(GH_ACCEPT);
    expect(calls[0]?.headers.get("x-github-api-version")).toBe(GH_API_VERSION);
  });
});
