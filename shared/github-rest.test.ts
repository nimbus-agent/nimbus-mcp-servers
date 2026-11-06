import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  GH_ACCEPT,
  GH_API,
  GH_API_VERSION,
  GH_HEADERS,
  ghApiBase,
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

describe("ghApiBase (GitHub Enterprise Server)", () => {
  afterEach(() => {
    delete process.env["GITHUB_API_BASE_URL"];
  });

  it("is api.github.com when GITHUB_API_BASE_URL is unset or blank", () => {
    delete process.env["GITHUB_API_BASE_URL"];
    expect(ghApiBase()).toBe(GH_API);
    process.env["GITHUB_API_BASE_URL"] = "  ";
    expect(ghApiBase()).toBe(GH_API);
  });

  it("is read per call and loses a trailing slash", () => {
    process.env["GITHUB_API_BASE_URL"] = "https://ghe.example.com/api/v3/";
    expect(ghApiBase()).toBe("https://ghe.example.com/api/v3");
  });

  it("routes ghFetch to the GHES host without doubling the /api/v3 prefix", async () => {
    process.env["GITHUB_API_BASE_URL"] = "https://ghe.example.com/api/v3";
    const urls: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
      urls.push(typeof input === "string" ? input : String(input));
      return new Response("{}", { status: 200 });
    }) as typeof globalThis.fetch;
    await ghFetch("t", ghRepoPath("o", "r"));
    await ghFetch(
      "t",
      ghQueryPath("/repos/o/r/pulls", (q) => q.set("state", "all")),
    );
    expect(urls).toEqual([
      "https://ghe.example.com/api/v3/repos/o/r",
      "https://ghe.example.com/api/v3/repos/o/r/pulls?state=all",
    ]);
  });

  it("keeps ghQueryPath relative whatever the base is", () => {
    process.env["GITHUB_API_BASE_URL"] = "https://ghe.example.com/api/v3";
    expect(ghQueryPath("/user/repos", (q) => q.set("a", "b"))).toBe("/user/repos?a=b");
  });
});

describe("ghFetch redirects", () => {
  const seen: { url: string; method: string }[] = [];
  function script(steps: Response[]): void {
    seen.length = 0;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: String(input), method: init?.method ?? "GET" });
      const step = steps.shift();
      if (step === undefined) throw new Error("unscripted request");
      return step;
    }) as typeof globalThis.fetch;
  }
  const moved = (status: number, location: string): Response =>
    new Response(null, { status, headers: { location } });

  it("refuses a 301 on a POST and sends no second request", async () => {
    script([moved(301, `${GH_API}/repositories/1/git/refs`), new Response("{}", { status: 200 })]);
    await expect(
      ghFetch("t", `${ghRepoPath("o", "r")}/git/refs`, { method: "POST", body: "{}" }),
    ).rejects.toThrow(/answered a POST with a redirect/);
    expect(seen).toHaveLength(1);
  });

  it("refuses a redirect on a PATCH", async () => {
    script([moved(308, `${GH_API}/repositories/1/pulls/2`)]);
    await expect(ghFetch("t", "/repos/o/r/pulls/2", { method: "PATCH" })).rejects.toThrow(
      /answered a PATCH with a redirect/,
    );
    expect(seen).toHaveLength(1);
  });

  it("follows a same-origin 301 on a GET", async () => {
    script([moved(301, `${GH_API}/repositories/1`), new Response('{"id":1}', { status: 200 })]);
    const res = await ghFetch("t", ghRepoPath("o", "r"));
    expect(res.ok).toBe(true);
    expect(res.json).toEqual({ id: 1 });
    expect(seen.map((s) => s.url)).toEqual([`${GH_API}/repos/o/r`, `${GH_API}/repositories/1`]);
  });

  it("refuses a cross-origin 302 on a GET", async () => {
    script([moved(302, "https://evil.test/steal")]);
    await expect(ghFetch("t", ghRepoPath("o", "r"))).rejects.toThrow(/another origin/);
    expect(seen).toHaveLength(1);
  });

  it("keeps a GitHub Enterprise Server /api/v3 base", async () => {
    process.env["GITHUB_API_BASE_URL"] = "https://ghe.example.com/api/v3";
    try {
      script([new Response("{}", { status: 200 })]);
      await ghFetch("t", "/repos/o/r");
      expect(seen[0]?.url).toBe("https://ghe.example.com/api/v3/repos/o/r");
    } finally {
      delete process.env["GITHUB_API_BASE_URL"];
    }
  });
});

describe("ghRepoPath dot segments", () => {
  it("refuses . and .. in owner or repo", () => {
    for (const bad of [".", ".."]) {
      expect(() => ghRepoPath(bad, "r")).toThrow(/dot segment/);
      expect(() => ghRepoPath("o", bad)).toThrow(/dot segment/);
    }
  });
});
