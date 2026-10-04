import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  GH_ACCEPT,
  GH_API,
  GH_API_VERSION,
  GH_HEADERS,
  ghFetch,
  ghQueryPath,
  ghRepoPath,
  setGhPaging,
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

describe("setGhPaging", () => {
  function paged(paging: Parameters<typeof setGhPaging>[1]): string {
    const params = new URLSearchParams();
    setGhPaging(params, paging);
    return params.toString();
  }

  it("defaults per_page to GitHub's own 30 and leaves page out", () => {
    expect(paged({})).toBe("per_page=30");
    expect(paged({ perPage: undefined, page: undefined })).toBe("per_page=30");
  });

  it("sends per_page, then page, when both are given", () => {
    expect(paged({ perPage: 100, page: 3 })).toBe("per_page=100&page=3");
  });

  it("appends after parameters already set, so a caller controls the order", () => {
    const params = new URLSearchParams({ state: "open" });
    setGhPaging(params, { page: 2 });
    params.set("sort", "updated");
    expect(params.toString()).toBe("state=open&per_page=30&page=2&sort=updated");
  });
});

describe("ghQueryPath", () => {
  it("returns the relative path with the query, in the order it was set", () => {
    expect(
      ghQueryPath(`${ghRepoPath("o", "r")}/pulls`, (q) => {
        q.set("state", "all");
        q.set("per_page", "5");
      }),
    ).toBe("/repos/o/r/pulls?state=all&per_page=5");
  });

  it("returns the bare path when no parameter is set", () => {
    expect(ghQueryPath("/user/repos", () => undefined)).toBe("/user/repos");
  });

  it("form-encodes parameter values and keeps encoded path segments", () => {
    expect(
      ghQueryPath(ghRepoPath("a b", "c/d"), (q) => {
        q.set("affiliation", "owner,collaborator");
      }),
    ).toBe("/repos/a%20b/c%2Fd?affiliation=owner%2Ccollaborator");
  });
});
