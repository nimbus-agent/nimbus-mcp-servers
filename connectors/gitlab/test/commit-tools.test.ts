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
import { registerGitlabTools } from "../src/tools.ts";

const API = "https://gitlab.com/api/v4";
const PROJ = `${API}/projects/group%2Frepo`;
const HEAD = "a".repeat(40);
const OTHER = "b".repeat(40);
const b64 = (text: string): string => Buffer.from(text, "utf8").toString("base64");

type Repo = {
  head: string;
  /** path -> GitLab file reply (404 when absent). */
  files: Record<string, { content: string; lastCommitId: string; exec?: boolean; size?: number }>;
  commit: StubReply;
};

let repo: Repo;
let http: FetchStub | undefined;
let tools: CapturedTools;

function freshRepo(): Repo {
  return {
    head: HEAD,
    files: {
      "README.md": { content: b64("hello"), lastCommitId: "c1" },
      "bin/run.sh": { content: b64("#!sh"), lastCommitId: "c2", exec: true },
      "logo.png": {
        content: Buffer.from([0x89, 0x00, 0xff]).toString("base64"),
        lastCommitId: "c3",
      },
      "big.txt": { content: b64("x"), lastCommitId: "c4", size: 300_000 },
      "lib/class.rb": { content: b64("class A; end"), lastCommitId: "c5" },
    },
    commit: {
      status: 201,
      body: JSON.stringify({
        id: "newcommit",
        parent_ids: [HEAD],
        web_url: "https://gitlab.com/c",
      }),
    },
  };
}

function serve(): FetchStub {
  http?.restore();
  http = stubFetch((req: RecordedRequest) => {
    const url = new URL(req.url);
    const path = url.pathname.replace("/api/v4/projects/group%2Frepo", "");
    if (path.startsWith("/repository/branches/")) {
      const name = decodeURIComponent(path.slice("/repository/branches/".length));
      return name === "gone"
        ? { status: 404, body: "{}" }
        : JSON.stringify({ commit: { id: repo.head } });
    }
    if (path.startsWith("/repository/commits/") && req.method === "GET") {
      return JSON.stringify({ id: repo.head });
    }
    if (path === "/repository/commits" && req.method === "POST") return repo.commit;
    if (path.startsWith("/repository/files/")) {
      const encoded = path.slice("/repository/files/".length);
      const file = repo.files[decodeURIComponent(encoded)];
      if (file === undefined) return { status: 404, body: "{}" };
      return JSON.stringify({
        content: file.content,
        last_commit_id: file.lastCommitId,
        execute_filemode: file.exec === true,
        size: file.size ?? Buffer.from(file.content, "base64").length,
        encoding: "base64",
      });
    }
    return undefined;
  });
  return http;
}

beforeEach(() => {
  resetConnectorModeForTests();
  setConnectorMode("gateway");
  process.env["GITLAB_PAT"] = "glpat-test";
  delete process.env["GITLAB_API_BASE_URL"];
  repo = freshRepo();
  tools = captureTools(registerGitlabTools);
});

afterEach(() => {
  http?.restore();
  http = undefined;
  delete process.env["GITLAB_PAT"];
  resetConnectorModeForTests();
});

const line = (r: RecordedRequest): string => `${r.method} ${r.url.slice(API.length)}`;
const writes = (s: FetchStub): RecordedRequest[] => s.calls.filter((c) => c.method !== "GET");
const BASE = { projectPath: "group/repo", branch: "main" };

describe("gitlab_files_get", () => {
  it("resolves the ref and reads each path with the fully encoded file path", async () => {
    const stub = serve();
    const out = (await tools.callJson("gitlab_files_get", {
      projectPath: "group/repo",
      ref: "main",
      paths: ["lib/class.rb", "nope.txt", "logo.png", "big.txt", "bin/run.sh"],
    })) as { headSha: string; files: Record<string, unknown>[] };
    expect(out.headSha).toBe(HEAD);
    const by = Object.fromEntries(out.files.map((f) => [f["path"], f]));
    expect(by["lib/class.rb"]).toMatchObject({
      exists: true,
      content: "class A; end",
      lastCommitId: "c5",
    });
    expect(by["nope.txt"]).toEqual({ path: "nope.txt", exists: false });
    expect(by["logo.png"]).toMatchObject({ withheld: "binary" });
    expect(by["big.txt"]).toMatchObject({ withheld: "too-large" });
    expect(by["bin/run.sh"]).toMatchObject({ executable: true });
    // Slashes as %2F AND dots as %2E, as the page's example (lib%2Fclass%2Erb) does.
    expect(stub.calls[1]?.url).toBe(`${PROJ}/repository/files/lib%2Fclass%2Erb?ref=${HEAD}`);
    expect(stub.calls.every((c) => c.headers["private-token"] === "glpat-test")).toBe(true);
  });

  it("refuses bad paths and a missing token before any request", async () => {
    const stub = serve();
    for (const paths of [["../x"], ["a//b"], [".git/x"], []]) {
      await expect(
        tools.call("gitlab_files_get", { projectPath: "group/repo", ref: "main", paths }),
      ).rejects.toThrow();
    }
    delete process.env["GITLAB_PAT"];
    await expect(
      tools.call("gitlab_files_get", { projectPath: "group/repo", ref: "main", paths: ["a"] }),
    ).rejects.toThrow("GITLAB_PAT is not set");
    expect(stub.calls).toEqual([]);
  });
});

describe("gitlab_commit_prepare", () => {
  it("returns the head and each file's state with no write request", async () => {
    const stub = serve();
    const out = await tools.callJson("gitlab_commit_prepare", {
      ...BASE,
      files: [
        { path: "README.md", content: "new" },
        { path: "bin/run.sh", content: "x" },
        { path: "fresh.txt", content: "x" },
      ],
    });
    expect(out).toEqual({
      headSha: HEAD,
      files: [
        {
          path: "README.md",
          exists: true,
          lastCommitId: "c1",
          executable: false,
          oldContent: "hello",
        },
        {
          path: "bin/run.sh",
          exists: true,
          lastCommitId: "c2",
          executable: true,
          oldContent: "#!sh",
        },
        { path: "fresh.txt", exists: false },
      ],
    });
    expect(writes(stub)).toEqual([]);
  });

  it("refuses non-text targets, >20 files, duplicates, and an over-cap commit", async () => {
    const stub = serve();
    for (const path of ["logo.png", "big.txt"]) {
      await expect(
        tools.call("gitlab_commit_prepare", { ...BASE, files: [{ path, content: "x" }] }),
      ).rejects.toThrow("not a text file the commit tools can overwrite");
    }
    const many = Array.from({ length: 21 }, (_, i) => ({ path: `f${String(i)}`, content: "x" }));
    await expect(tools.call("gitlab_commit_prepare", { ...BASE, files: many })).rejects.toThrow();
    await expect(
      tools.call("gitlab_commit_prepare", {
        ...BASE,
        files: [
          { path: "a", content: "1" },
          { path: "a", content: "2" },
        ],
      }),
    ).rejects.toThrow("duplicate file path");
    await expect(
      tools.call("gitlab_commit_prepare", {
        ...BASE,
        files: [{ path: "README.md", content: "x".repeat(192 * 1024 - 2) }],
      }),
    ).rejects.toThrow("commit too large");
    expect(writes(stub)).toEqual([]);
  });

  it("a missing branch and bad input are refused", async () => {
    const stub = serve();
    await expect(
      tools.call("gitlab_commit_prepare", {
        ...BASE,
        branch: "gone",
        files: [{ path: "a", content: "x" }],
      }),
    ).rejects.toThrow('branch "gone" not found');
    const before = stub.calls.length;
    await expect(
      tools.call("gitlab_commit_prepare", {
        ...BASE,
        branch: "../x",
        files: [{ path: "a", content: "x" }],
      }),
    ).rejects.toThrow();
    expect(stub.calls.length).toBe(before);
  });
});

describe("gitlab_commit_create", () => {
  const INPUT = {
    ...BASE,
    message: "Update",
    expectedHeadSha: HEAD,
    files: [
      { path: "README.md", content: "new readme" },
      { path: "lib/class.rb", content: "class B; end" },
      { path: "docs/new.md", content: "fresh" },
    ],
  };

  it("checks the head, reads each existing file at it, then POSTs one commit with exact actions", async () => {
    const stub = serve();
    const out = await tools.callJson("gitlab_commit_create", INPUT);
    expect(out).toEqual({
      ok: true,
      commitId: "newcommit",
      branch: "main",
      parent: HEAD,
      webUrl: "https://gitlab.com/c",
      movedHead: false,
    });
    expect(stub.calls.map(line)).toEqual([
      "GET /projects/group%2Frepo/repository/branches/main",
      `GET /projects/group%2Frepo/repository/files/README%2Emd?ref=${HEAD}`,
      `GET /projects/group%2Frepo/repository/files/lib%2Fclass%2Erb?ref=${HEAD}`,
      `GET /projects/group%2Frepo/repository/files/docs%2Fnew%2Emd?ref=${HEAD}`,
      "POST /projects/group%2Frepo/repository/commits",
    ]);
    const post = stub.calls.at(-1);
    expect(post?.headers["content-type"]).toBe("application/json");
    // last_commit_id on UPDATE actions only; none on the create; no force, no start_branch.
    expect(JSON.parse(post?.body ?? "null")).toEqual({
      branch: "main",
      commit_message: "Update",
      actions: [
        {
          action: "update",
          file_path: "README.md",
          content: "new readme",
          encoding: "text",
          last_commit_id: "c1",
        },
        {
          action: "update",
          file_path: "lib/class.rb",
          content: "class B; end",
          encoding: "text",
          last_commit_id: "c5",
        },
        { action: "create", file_path: "docs/new.md", content: "fresh", encoding: "text" },
      ],
    });
    expect(post?.body).not.toContain("force");
    expect(post?.body).not.toContain("start_branch");
  });

  it("a head that is not the approved one throws and makes NO POST", async () => {
    const stub = serve();
    repo.head = OTHER;
    await expect(tools.callJson("gitlab_commit_create", INPUT)).rejects.toThrow(
      `branch head is ${OTHER}, not the approved ${HEAD}`,
    );
    expect(writes(stub)).toEqual([]);
    expect(stub.calls).toHaveLength(1);
  });

  it("reports movedHead when the new commit's parent is not the approved head", async () => {
    serve();
    repo.commit = {
      status: 201,
      body: JSON.stringify({ id: "n", parent_ids: [OTHER], web_url: "u" }),
    };
    expect(
      ((await tools.callJson("gitlab_commit_create", INPUT)) as { movedHead: boolean }).movedHead,
    ).toBe(true);
    repo.commit = { status: 201, body: JSON.stringify({ id: "n" }) };
    expect(
      ((await tools.callJson("gitlab_commit_create", INPUT)) as { movedHead: boolean }).movedHead,
    ).toBe(true);
  });

  it("surfaces GitLab's 400 (for example a last_commit_id mismatch) verbatim", async () => {
    serve();
    repo.commit = { status: 400, body: '{"message":"file changed"}' };
    await expect(tools.callJson("gitlab_commit_create", INPUT)).rejects.toThrow(
      'GitLab 400: {"message":"file changed"}',
    );
  });

  it("refuses binary and oversize targets before the POST", async () => {
    const stub = serve();
    for (const path of ["logo.png", "big.txt"]) {
      await expect(
        tools.call("gitlab_commit_create", { ...INPUT, files: [{ path, content: "x" }] }),
      ).rejects.toThrow("not a text file the commit tools can overwrite");
    }
    expect(writes(stub)).toEqual([]);
  });

  it("refuses bad input and a missing token before any request; a 307 on the POST is refused", async () => {
    const stub = serve();
    for (const bad of [
      { ...INPUT, expectedHeadSha: "abc" },
      { ...INPUT, branch: "../x" },
      { ...INPUT, message: "" },
      { ...INPUT, files: [{ path: "a/../b", content: "x" }] },
    ]) {
      await expect(tools.call("gitlab_commit_create", bad)).rejects.toThrow();
    }
    delete process.env["GITLAB_PAT"];
    await expect(tools.call("gitlab_commit_create", INPUT)).rejects.toThrow(
      "GITLAB_PAT is not set",
    );
    expect(stub.calls).toEqual([]);

    process.env["GITLAB_PAT"] = "glpat-test";
    repo.commit = { status: 307, headers: { Location: "https://evil.example/x" } };
    await expect(tools.callJson("gitlab_commit_create", INPUT)).rejects.toThrow(
      "answered a POST with a redirect (307)",
    );
    expect(stub.calls.some((c) => c.url.includes("evil.example"))).toBe(false);
  });

  it("a cross-origin 302 on a read is refused and no request reaches the other origin", async () => {
    const stub = serve();
    http?.restore();
    http = stubFetch({ status: 302, headers: { Location: "https://evil.example/x" } });
    await expect(
      tools.call("gitlab_files_get", { projectPath: "group/repo", ref: "main", paths: ["a"] }),
    ).rejects.toThrow("redirected to another origin");
    void stub;
    expect(http.calls).toHaveLength(1);
  });
});

describe("gitlab commit tools in standalone mode", () => {
  beforeEach(() => {
    resetConnectorModeForTests();
    setConnectorMode("standalone");
  });

  it("capturePreState reads the head and last_commit_ids BEFORE the POST, and is audited", async () => {
    const stub = serve();
    const run = await approvedStandaloneWrite(
      registerGitlabTools,
      { NIMBUS_MCP_GITLAB_WRITE_SCOPE: "repo:group/repo" },
      "gitlab_commit_create",
      {
        ...BASE,
        message: "m",
        files: [{ path: "README.md", content: "new" }],
        expectedHeadSha: HEAD,
      },
    );
    expect(run.answer).toMatchObject({ ok: true, parent: HEAD });
    const lines = stub.calls.map(line);
    const firstPost = lines.findIndex((l) => l.startsWith("POST"));
    expect(
      lines.slice(0, firstPost).filter((l) => l.includes("/repository/files/")).length,
    ).toBeGreaterThanOrEqual(2);
    expect(run.audit.find((e) => e.outcome === "executed")?.detail["preState"]).toEqual({
      branch: "main",
      headSha: HEAD,
      files: [{ path: "README.md", lastCommitId: "c1" }],
    });
    expect(run.chain.ok).toBe(true);
  });

  it("the prepare tool is offered to a client that cannot prompt and is scope-checked", async () => {
    const stub = serve();
    await withEnv({ NIMBUS_MCP_GITLAB_WRITE_SCOPE: "repo:other/thing" }, async () => {
      const { tools: t } = captureStandaloneTools(registerGitlabTools, { elicitation: false });
      expect(t.names()).toContain("gitlab_commit_prepare");
      expect(t.names()).not.toContain("gitlab_commit_create");
      const res = (await t.callJson("gitlab_commit_prepare", {
        ...BASE,
        files: [{ path: "a", content: "x" }],
      })) as { ok: boolean; error: string };
      expect(res.ok).toBe(false);
      expect(res.error).toContain("out of scope: repo:group/repo");
    });
    expect(stub.calls).toEqual([]);
  });
});
