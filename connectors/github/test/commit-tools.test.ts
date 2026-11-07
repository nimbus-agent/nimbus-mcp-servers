import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  approvedStandaloneWrite,
  type CapturedTools,
  captureStandaloneTools,
  captureTools,
  type FetchStub,
  type RecordedRequest,
  type StubReply,
  stubFetch,
  withEnv,
} from "../../../scripts/connector-tool-harness.ts";
import { resetConnectorModeForTests, setConnectorMode } from "../../../shared/connector-mode.ts";
import { registerGithubTools } from "../src/tools.ts";

const API = "https://api.github.com";
const REPO = `${API}/repos/acme/api`;
const HEAD = "a".repeat(40);
const OTHER_HEAD = "b".repeat(40);
const ROOT_TREE = "1".repeat(40);
const SRC_TREE = "2".repeat(40);
const b64 = (text: string): string => Buffer.from(text, "utf8").toString("base64");

type Repo = {
  head: string;
  rootEntries: unknown[];
  truncatedRoot: boolean;
  blobs: Record<string, string>;
  patch: StubReply;
  blobStatus: number;
};

function freshRepo(): Repo {
  return {
    head: HEAD,
    truncatedRoot: false,
    rootEntries: [
      { path: "README.md", mode: "100644", type: "blob", sha: "r1", size: 5 },
      { path: "run.sh", mode: "100755", type: "blob", sha: "r2", size: 4 },
      { path: "link", mode: "120000", type: "blob", sha: "r3", size: 4 },
      { path: "vendor", mode: "160000", type: "commit", sha: "r4" },
      { path: "logo.png", mode: "100644", type: "blob", sha: "r5", size: 4 },
      { path: "big.txt", mode: "100644", type: "blob", sha: "r6", size: 300_000 },
      { path: "src", mode: "040000", type: "tree", sha: SRC_TREE },
    ],
    blobs: {
      r1: b64("hello"),
      r2: b64("#!sh"),
      r5: Buffer.from([0x89, 0x50, 0x00, 0xff]).toString("base64"),
      a1: b64("export {}"),
    },
    patch: "{}",
    blobStatus: 200,
  };
}

let repo: Repo;
let http: FetchStub | undefined;
let nextBlob = 0;
let tools: CapturedTools;

function server(): FetchStub {
  http?.restore();
  nextBlob = 0;
  http = stubFetch((req: RecordedRequest) => {
    const path = req.url.slice(REPO.length);
    const key = `${req.method} ${path}`;
    if (key === "GET /commits/refs/heads/main" || key === "GET /commits/refs/heads/feature/x") {
      return repo.head;
    }
    if (key === "GET /commits/refs/heads/gone") return { status: 404, body: "{}" };
    if (key === `GET /git/commits/${repo.head}`)
      return JSON.stringify({ tree: { sha: ROOT_TREE } });
    if (key === `GET /git/trees/${ROOT_TREE}`) {
      return JSON.stringify({ tree: repo.rootEntries, truncated: repo.truncatedRoot });
    }
    if (key === `GET /git/trees/${SRC_TREE}`) {
      return JSON.stringify({
        tree: [{ path: "a.ts", mode: "100644", type: "blob", sha: "a1", size: 9 }],
      });
    }
    const blob = /^GET \/git\/blobs\/(\w+)$/.exec(key);
    if (blob !== null) {
      const content = repo.blobs[blob[1] ?? ""];
      return content === undefined
        ? { status: 404, body: "{}" }
        : JSON.stringify({ encoding: "base64", content });
    }
    if (key === "POST /git/blobs") {
      nextBlob += 1;
      return { status: repo.blobStatus, body: JSON.stringify({ sha: `nb${String(nextBlob)}` }) };
    }
    if (key === "POST /git/trees") return JSON.stringify({ sha: "nt" });
    if (key === "POST /git/commits") return JSON.stringify({ sha: "nc" });
    if (key.startsWith("PATCH /git/refs/heads/")) return repo.patch;
    return undefined;
  });
  return http;
}

beforeEach(() => {
  resetConnectorModeForTests();
  setConnectorMode("gateway");
  repo = freshRepo();
  tools = captureTools(registerGithubTools);
});

afterEach(() => {
  http?.restore();
  http = undefined;
  resetConnectorModeForTests();
});

function call(name: string, args: Record<string, unknown>): Promise<unknown> {
  return withEnv({ GITHUB_PAT: "ghp_test" }, () => tools.callJson(name, args));
}

const line = (r: RecordedRequest): string => `${r.method} ${r.url.slice(REPO.length)}`;
const posts = (s: FetchStub): RecordedRequest[] =>
  s.calls.filter((c) => c.method === "POST" || c.method === "PATCH");

const BASE = { owner: "acme", repo: "api", branch: "main" };

describe("github_files_get", () => {
  it("resolves the ref, then returns text content, absent files and withheld kinds", async () => {
    server();
    const out = (await call("github_files_get", {
      owner: "acme",
      repo: "api",
      ref: "main",
      paths: ["README.md", "src/a.ts", "nope.txt", "link", "vendor", "logo.png", "big.txt"],
    })) as { ref: string; headSha: string; files: Record<string, unknown>[] };
    expect(out.headSha).toBe(HEAD);
    const byPath = Object.fromEntries(out.files.map((f) => [f["path"], f]));
    expect(byPath["README.md"]).toMatchObject({
      exists: true,
      mode: "100644",
      sha: "r1",
      content: "hello",
    });
    expect(byPath["src/a.ts"]).toMatchObject({ exists: true, content: "export {}" });
    expect(byPath["nope.txt"]).toEqual({ path: "nope.txt", exists: false });
    expect(byPath["link"]).toMatchObject({ withheld: "not-regular" });
    expect(byPath["vendor"]).toMatchObject({ withheld: "not-regular" });
    expect(byPath["logo.png"]).toMatchObject({ withheld: "binary" });
    expect(byPath["big.txt"]).toMatchObject({ withheld: "too-large" });
    expect(byPath["logo.png"]).not.toHaveProperty("content");
  });

  it("refuses bad paths and a missing token before any request", async () => {
    const stub = server();
    for (const paths of [["../x"], ["a//b"], ["/abs"], ["a/.git/config"], ["a\\b"], []]) {
      await expect(
        call("github_files_get", { owner: "acme", repo: "api", ref: "main", paths }),
      ).rejects.toThrow();
    }
    await withEnv({ GITHUB_PAT: undefined }, async () => {
      await expect(
        tools.call("github_files_get", { owner: "acme", repo: "api", ref: "main", paths: ["a"] }),
      ).rejects.toThrow("GITHUB_PAT is not set");
    });
    expect(stub.calls).toEqual([]);
  });
});

describe("github_commit_prepare", () => {
  const FILES = [
    { path: "README.md", content: "hello world" },
    { path: "src/new.ts", content: "x" },
  ];

  it("returns the head and each file's current state, with no write request", async () => {
    const stub = server();
    const out = await call("github_commit_prepare", { ...BASE, files: FILES });
    expect(out).toEqual({
      headSha: HEAD,
      files: [
        { path: "README.md", exists: true, mode: "100644", oldSha: "r1", oldContent: "hello" },
        { path: "src/new.ts", exists: false, mode: "100644" },
      ],
    });
    expect(posts(stub)).toEqual([]);
  });

  it("refuses an existing file it cannot overwrite as text", async () => {
    server();
    for (const path of ["link", "vendor", "logo.png", "big.txt"]) {
      await expect(
        call("github_commit_prepare", { ...BASE, files: [{ path, content: "x" }] }),
      ).rejects.toThrow("not a text file the commit tools can overwrite");
    }
  });

  it("refuses more than 20 files, duplicate paths, and old plus new over 192 KiB (no truncation)", async () => {
    const stub = server();
    const many = Array.from({ length: 21 }, (_, i) => ({
      path: `f${String(i)}.txt`,
      content: "x",
    }));
    await expect(call("github_commit_prepare", { ...BASE, files: many })).rejects.toThrow();
    await expect(
      call("github_commit_prepare", {
        ...BASE,
        files: [
          { path: "a.txt", content: "1" },
          { path: "a.txt", content: "2" },
        ],
      }),
    ).rejects.toThrow("duplicate file path");
    expect(stub.calls).toEqual([]);
    // 190 KiB of new content plus the 5 old bytes is under; 192 KiB of new plus 5 old is over.
    const under = "x".repeat(190 * 1024);
    await call("github_commit_prepare", {
      ...BASE,
      files: [{ path: "README.md", content: under }],
    });
    await expect(
      call("github_commit_prepare", {
        ...BASE,
        files: [{ path: "README.md", content: "x".repeat(192 * 1024 - 2) }],
      }),
    ).rejects.toThrow("commit too large");
  });

  it("refuses a truncated directory listing rather than guessing a file is new", async () => {
    server();
    repo.truncatedRoot = true;
    await expect(call("github_commit_prepare", { ...BASE, files: FILES })).rejects.toThrow(
      "truncated a directory listing",
    );
  });

  it("refuses a path under a file, a missing branch, bad input and a missing token", async () => {
    const stub = server();
    await expect(
      call("github_commit_prepare", { ...BASE, files: [{ path: "README.md/x", content: "x" }] }),
    ).rejects.toThrow("is a file, not a directory");
    await expect(
      call("github_commit_prepare", { ...BASE, branch: "gone", files: FILES }),
    ).rejects.toThrow("not found");
    const before = stub.calls.length;
    for (const bad of [
      { ...BASE, branch: "../x", files: FILES },
      { ...BASE, owner: "..", files: FILES },
      { ...BASE, files: [{ path: "../x", content: "x" }] },
      { ...BASE, files: [] },
    ]) {
      await expect(call("github_commit_prepare", bad)).rejects.toThrow();
    }
    await withEnv({ GITHUB_PAT: undefined }, async () => {
      await expect(tools.call("github_commit_prepare", { ...BASE, files: FILES })).rejects.toThrow(
        "GITHUB_PAT is not set",
      );
    });
    expect(stub.calls.length).toBe(before);
  });
});

describe("github_file_commit", () => {
  const FILES = [
    { path: "run.sh", content: "#!/bin/sh\necho hi\n" },
    { path: "src/new.ts", content: "export const n = 1;\n" },
  ];
  const INPUT = { ...BASE, message: "Update files", files: FILES, expectedHeadSha: HEAD };

  it("runs the documented sequence: head, tree, blobs, tree, commit, fast-forward ref update", async () => {
    const stub = server();
    const out = await call("github_file_commit", INPUT);
    expect(out).toEqual({ ok: true, commitSha: "nc", branch: "main", parent: HEAD });
    expect(stub.calls.map(line)).toEqual([
      "GET /commits/refs/heads/main",
      `GET /git/commits/${HEAD}`,
      `GET /git/trees/${ROOT_TREE}`,
      "GET /git/blobs/r2",
      `GET /git/trees/${SRC_TREE}`,
      "POST /git/blobs",
      "POST /git/blobs",
      "POST /git/trees",
      "POST /git/commits",
      "PATCH /git/refs/heads/main",
    ]);
    const body = (i: number): unknown => JSON.parse(stub.calls[i]?.body ?? "null");
    expect(body(5)).toEqual({ content: FILES[0]?.content, encoding: "utf-8" });
    expect(body(6)).toEqual({ content: FILES[1]?.content, encoding: "utf-8" });
    // The existing file keeps its executable mode; the new one is a plain file.
    expect(body(7)).toEqual({
      base_tree: ROOT_TREE,
      tree: [
        { path: "run.sh", mode: "100755", type: "blob", sha: "nb1" },
        { path: "src/new.ts", mode: "100644", type: "blob", sha: "nb2" },
      ],
    });
    expect(body(8)).toEqual({ message: "Update files", tree: "nt", parents: [HEAD] });
    expect(body(9)).toEqual({ sha: "nc", force: false });
    for (const c of posts(stub)) expect(c.headers["authorization"]).toBe("Bearer ghp_test");
  });

  it("a branch name with a slash is encoded per segment in the ref path", async () => {
    const stub = server();
    await call("github_file_commit", { ...INPUT, branch: "feature/x" });
    expect(stub.calls.at(-1)?.url).toBe(`${REPO}/git/refs/heads/feature/x`);
  });

  it("a head that is not the approved one throws and makes ZERO write requests", async () => {
    const stub = server();
    repo.head = OTHER_HEAD;
    await expect(call("github_file_commit", INPUT)).rejects.toThrow(
      `branch head is ${OTHER_HEAD}, not the approved ${HEAD}`,
    );
    expect(posts(stub)).toEqual([]);
    expect(stub.calls).toHaveLength(1);
  });

  it("re-resolves the head at call time: a read taken once cannot satisfy it", async () => {
    const stub = server();
    await call("github_file_commit", INPUT);
    expect(stub.calls.filter((c) => c.url.includes("/commits/refs/heads/"))).toHaveLength(1);
    expect(stub.calls[0]?.url).toBe(`${REPO}/commits/refs/heads/main`);
  });

  it("refuses symlink, submodule and binary targets, and oversize, before any write", async () => {
    const stub = server();
    for (const path of ["link", "vendor", "logo.png", "big.txt"]) {
      await expect(
        call("github_file_commit", { ...INPUT, files: [{ path, content: "x" }] }),
      ).rejects.toThrow("not a text file the commit tools can overwrite");
    }
    await expect(
      call("github_file_commit", {
        ...INPUT,
        files: [{ path: "README.md", content: "x".repeat(192 * 1024) }],
      }),
    ).rejects.toThrow("commit too large");
    expect(posts(stub)).toEqual([]);
  });

  it("surfaces a 422 (or 409) on the ref update as a moved head or a refusal", async () => {
    server();
    repo.patch = { status: 422, body: '{"message":"Update is not a fast forward"}' };
    await expect(call("github_file_commit", INPUT)).rejects.toThrow(
      "GitHub 422: head moved or ref update refused: ",
    );
    repo.patch = { status: 409, body: "{}" };
    await expect(call("github_file_commit", INPUT)).rejects.toThrow("GitHub 409: head moved");
    repo.patch = { status: 500, body: "boom" };
    await expect(call("github_file_commit", INPUT)).rejects.toThrow("GitHub 500: boom");
  });

  it("a failed blob stops the commit before any tree exists", async () => {
    const stub = server();
    repo.blobStatus = 500;
    await expect(call("github_file_commit", INPUT)).rejects.toThrow("GitHub 500");
    expect(stub.calls.map(line).filter((l) => l.startsWith("POST"))).toEqual(["POST /git/blobs"]);
  });

  it("refuses bad paths, branch, sha and message, and a missing token, before any request", async () => {
    const stub = server();
    for (const bad of [
      { ...INPUT, expectedHeadSha: "abc" },
      { ...INPUT, branch: "../x" },
      { ...INPUT, message: "" },
      { ...INPUT, files: [{ path: "a/../b", content: "x" }] },
      { ...INPUT, files: [] },
    ]) {
      await expect(call("github_file_commit", bad)).rejects.toThrow();
    }
    await withEnv({ GITHUB_PAT: undefined }, async () => {
      await expect(tools.call("github_file_commit", INPUT)).rejects.toThrow(
        "GITHUB_PAT is not set",
      );
    });
    expect(stub.calls).toEqual([]);
  });

  it("a 302 on the ref update is refused, not replayed", async () => {
    const stub = server();
    repo.patch = { status: 302, headers: { Location: "https://evil.example/x" } };
    await expect(call("github_file_commit", INPUT)).rejects.toThrow(
      "answered a PATCH with a redirect",
    );
    expect(stub.calls.some((c) => c.url.includes("evil.example"))).toBe(false);
  });
});

describe("github_file_commit in standalone mode", () => {
  beforeEach(() => {
    resetConnectorModeForTests();
    setConnectorMode("standalone");
  });

  it("capturePreState reads the head and old blob shas BEFORE the first write, and is audited", async () => {
    const stub = server();
    const run = await withEnv({ GITHUB_PAT: "ghp_test" }, () =>
      approvedStandaloneWrite(
        registerGithubTools,
        { NIMBUS_MCP_GITHUB_WRITE_SCOPE: "repo:acme/api" },
        "github_file_commit",
        {
          ...BASE,
          message: "m",
          files: [{ path: "README.md", content: "new" }],
          expectedHeadSha: HEAD,
        },
      ),
    );
    expect(run.answer).toMatchObject({ ok: true, parent: HEAD });
    const lines = stub.calls.map(line);
    const firstWrite = lines.findIndex((l) => l.startsWith("POST") || l.startsWith("PATCH"));
    const captureReads = lines.slice(0, firstWrite).filter((l) => l.startsWith("GET /git/trees/"));
    // One tree read for the capture and one for the commit itself, both before any write.
    expect(captureReads.length).toBeGreaterThanOrEqual(2);
    expect(run.audit.find((e) => e.outcome === "executed")?.detail["preState"]).toEqual({
      branch: "main",
      headSha: HEAD,
      files: [{ path: "README.md", oldSha: "r1" }],
    });
    expect(run.chain.ok).toBe(true);
  });

  it("a head that moved after the capture is refused with no write", async () => {
    const stub = server();
    repo.head = OTHER_HEAD;
    await withEnv({ GITHUB_PAT: "ghp_test" }, async () => {
      await expect(
        approvedStandaloneWrite(
          registerGithubTools,
          { NIMBUS_MCP_GITHUB_WRITE_SCOPE: "repo:acme/api" },
          "github_file_commit",
          {
            ...BASE,
            message: "m",
            files: [{ path: "a.txt", content: "x" }],
            expectedHeadSha: HEAD,
          },
        ),
      ).rejects.toThrow("not the approved");
    });
    expect(posts(stub)).toEqual([]);
  });
});

describe("github_commit_prepare in standalone mode", () => {
  beforeEach(() => {
    resetConnectorModeForTests();
    setConnectorMode("standalone");
  });

  it("is offered to a client that cannot prompt, and refuses out of scope before any request", async () => {
    const stub = server();
    await withEnv(
      { GITHUB_PAT: "ghp_test", NIMBUS_MCP_GITHUB_WRITE_SCOPE: "repo:other/thing" },
      async () => {
        const { tools: standalone } = captureStandaloneTools(registerGithubTools, {
          elicitation: false,
        });
        expect(standalone.names()).toContain("github_commit_prepare");
        expect(standalone.names()).not.toContain("github_file_commit");
        const res = (await standalone.callJson("github_commit_prepare", {
          ...BASE,
          files: [{ path: "a.txt", content: "x" }],
        })) as { ok: boolean; error: string };
        expect(res.ok).toBe(false);
        expect(res.error).toContain("out of scope: repo:acme/api");
      },
    );
    expect(stub.calls).toEqual([]);
  });

  it("in scope it runs and returns the prepared state", async () => {
    server();
    await withEnv(
      { GITHUB_PAT: "ghp_test", NIMBUS_MCP_GITHUB_WRITE_SCOPE: "repo:acme/api" },
      async () => {
        const { tools: standalone } = captureStandaloneTools(registerGithubTools, {
          elicitation: false,
        });
        const res = (await standalone.callJson("github_commit_prepare", {
          ...BASE,
          files: [{ path: "a.txt", content: "x" }],
        })) as { headSha: string };
        expect(res.headSha).toBe(HEAD);
      },
    );
  });
});
