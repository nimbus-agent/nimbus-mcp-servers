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
import { registerGithubTools } from "../src/tools.ts";

const API = "https://api.github.com/repos/acme/api";
const SHA = "0123456789abcdef0123456789abcdef01234567";
const PARENT = "fedcba9876543210fedcba9876543210fedcba98";

let tools: CapturedTools;
let http: FetchStub | undefined;

function serve(reply: StubReply | ((req: RecordedRequest) => StubReply | undefined)): FetchStub {
  http?.restore();
  http = stubFetch(reply);
  return http;
}

beforeEach(() => {
  resetConnectorModeForTests();
  setConnectorMode("gateway");
  tools = captureTools(registerGithubTools);
});
afterEach(() => {
  http?.restore();
  http = undefined;
  resetConnectorModeForTests();
});

const COMMIT = {
  sha: SHA,
  commit: {
    message: "Fix the parser\n\nA long body that must not appear.",
    author: { name: "Ada", email: "ada@example.com", date: "2026-11-01T10:00:00Z" },
  },
  parents: [{ sha: PARENT, url: "u" }],
  files: [{ filename: "a.ts", patch: "dropped" }],
  stats: { total: 1 },
};

function get(args: Record<string, unknown>): Promise<unknown> {
  return withEnv({ GITHUB_PAT: "ghp_test" }, () => tools.callJson("github_commit_get", args));
}

describe("github_commit_get", () => {
  it("GETs the commit and projects only sha, first line, author name and date, parents", async () => {
    const stub = serve(JSON.stringify(COMMIT));
    expect(await get({ repoFull: "acme/api", ref: SHA })).toEqual({
      sha: SHA,
      message: "Fix the parser",
      authorName: "Ada",
      authorDate: "2026-11-01T10:00:00Z",
      parents: [PARENT],
    });
    expect(`${stub.only.method} ${stub.only.url}`).toBe(`GET ${API}/commits/${SHA}`);
    expect(stub.only.headers["authorization"]).toBe("Bearer ghp_test");
  });

  it("clips the first line to 200 characters, by code point", async () => {
    serve(JSON.stringify({ ...COMMIT, commit: { ...COMMIT.commit, message: "x".repeat(300) } }));
    const out = (await get({ repoFull: "acme/api", ref: SHA })) as { message: string };
    expect(out.message).toHaveLength(200);
    serve(
      JSON.stringify({ ...COMMIT, commit: { ...COMMIT.commit, message: "\u{1F600}".repeat(250) } }),
    );
    const emoji = (await get({ repoFull: "acme/api", ref: SHA })) as { message: string };
    expect([...emoji.message]).toHaveLength(200);
    // No half of a surrogate pair at the cut.
    expect(emoji.message).toBe("\u{1F600}".repeat(200));
  });

  it("handles a CRLF message and a root commit with no parents", async () => {
    serve(
      JSON.stringify({
        ...COMMIT,
        commit: { ...COMMIT.commit, message: "Init\r\nbody" },
        parents: [],
      }),
    );
    const out = (await get({ repoFull: "acme/api", ref: SHA })) as {
      message: string;
      parents: string[];
    };
    expect(out.message).toBe("Init");
    expect(out.parents).toEqual([]);
  });

  it("a bare name is tried as a branch, then a tag, in the documented heads/ and tags/ forms", async () => {
    const stub = serve((req) =>
      req.url.endsWith("/commits/refs/tags/v1")
        ? JSON.stringify(COMMIT)
        : { status: 404, body: "{}" },
    );
    await get({ repoFull: "acme/api", ref: "v1" });
    expect(stub.calls.map((c) => c.url.slice(API.length))).toEqual([
      "/commits/refs/heads/v1",
      "/commits/refs/tags/v1",
    ]);
  });

  it("a heads/ ref with a slash is encoded per segment", async () => {
    const stub = serve(JSON.stringify(COMMIT));
    await get({ repoFull: "acme/api", ref: "heads/feature/x" });
    expect(stub.only.url).toBe(`${API}/commits/refs/heads/feature/x`);
  });

  it("an abbreviated sha is tried as a sha first", async () => {
    const stub = serve(JSON.stringify(COMMIT));
    await get({ repoFull: "acme/api", ref: "0123456" });
    expect(stub.only.url).toBe(`${API}/commits/0123456`);
  });

  it("404 and 422 'No commit found' are not found; every candidate is tried", async () => {
    const a = serve({ status: 404, body: "{}" });
    await expect(get({ repoFull: "acme/api", ref: "nope" })).rejects.toThrow("commit not found");
    expect(a.calls).toHaveLength(2);
    serve({ status: 422, body: '{"message":"No commit found for SHA: nope"}' });
    await expect(get({ repoFull: "acme/api", ref: SHA })).rejects.toThrow("commit not found");
  });

  it("a 422 with another message, and other failures, are real errors", async () => {
    serve({ status: 422, body: '{"message":"Validation Failed"}' });
    await expect(get({ repoFull: "acme/api", ref: SHA })).rejects.toThrow("GitHub 422: ");
    serve({ status: 500, body: "boom" });
    await expect(get({ repoFull: "acme/api", ref: SHA })).rejects.toThrow("GitHub 500: boom");
  });

  it("a reply with no sha is an error rather than an empty commit", async () => {
    serve("{}");
    await expect(get({ repoFull: "acme/api", ref: SHA })).rejects.toThrow(
      "GitHub returned no commit",
    );
  });

  it("refuses an unsafe ref or repoFull and a missing token before any request", async () => {
    const stub = serve(JSON.stringify(COMMIT));
    for (const bad of [
      { repoFull: "acme/api", ref: "../x" },
      { repoFull: "acme/api", ref: "a..b" },
      { repoFull: "acme/api", ref: "-x" },
      { repoFull: "acme/api", ref: "" },
      { repoFull: "acme", ref: SHA },
      { repoFull: "acme/api/extra", ref: SHA },
      { repoFull: "../api", ref: SHA },
      { repoFull: "acme/..", ref: SHA },
      { repoFull: "acme/ap i", ref: SHA },
    ]) {
      await expect(get(bad)).rejects.toThrow();
    }
    await withEnv({ GITHUB_PAT: undefined }, async () => {
      await expect(
        tools.call("github_commit_get", { repoFull: "acme/api", ref: SHA }),
      ).rejects.toThrow("GITHUB_PAT is not set");
    });
    expect(stub.calls).toEqual([]);
  });

  it("a cross-origin 302 is refused and nothing is sent to the other origin", async () => {
    const stub = serve({ status: 302, headers: { Location: "https://evil.example/x" } });
    await expect(get({ repoFull: "acme/api", ref: SHA })).rejects.toThrow(
      "redirected to another origin",
    );
    expect(stub.calls.some((c) => c.url.includes("evil.example"))).toBe(false);
  });
});
