import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
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

let http: FetchStub | undefined;

function serve(reply: StubReply | ((req: RecordedRequest) => StubReply | undefined)): FetchStub {
  http?.restore();
  http = stubFetch(reply);
  return http;
}

beforeEach(() => {
  resetConnectorModeForTests();
});

afterEach(() => {
  http?.restore();
  http = undefined;
  resetConnectorModeForTests();
});

describe("github write requests (gateway mode)", () => {
  let tools: CapturedTools;

  beforeEach(() => {
    setConnectorMode("gateway");
    tools = captureTools(registerGithubTools);
  });

  /** Call `name` with a PAT set; return the one request it made. */
  async function request(name: string, args: Record<string, unknown>): Promise<RecordedRequest> {
    const stub = serve('{"merged":true}');
    await withEnv({ GITHUB_PAT: "ghp_test" }, async () => {
      await tools.call(name, args);
    });
    return stub.only;
  }

  it("pr_merge PUTs an empty body when no merge options are given", async () => {
    const req = await request("github_pr_merge", { owner: "acme", repo: "api", pullNumber: 7 });
    expect(`${req.method} ${req.url}`).toBe(`PUT ${API}/repos/acme/api/pulls/7/merge`);
    expect(JSON.parse(req.body ?? "null")).toEqual({});
    expect(req.headers["authorization"]).toBe("Bearer ghp_test");
  });

  it("pr_merge sends the merge method and commit title it is given", async () => {
    const req = await request("github_pr_merge", {
      owner: "acme",
      repo: "api",
      pullNumber: 7,
      mergeMethod: "squash",
      commitTitle: "Ship it (#7)",
    });
    expect(JSON.parse(req.body ?? "null")).toEqual({
      merge_method: "squash",
      commit_title: "Ship it (#7)",
    });
  });

  it("pr_merge leaves out an empty commit title rather than sending one", async () => {
    const req = await request("github_pr_merge", {
      owner: "acme",
      repo: "api",
      pullNumber: 7,
      mergeMethod: "rebase",
      commitTitle: "",
    });
    expect(JSON.parse(req.body ?? "null")).toEqual({ merge_method: "rebase" });
  });
});

describe("github issue writes (gateway mode)", () => {
  let tools: CapturedTools;

  beforeEach(() => {
    setConnectorMode("gateway");
    tools = captureTools(registerGithubTools);
  });

  afterEach(() => {
    delete process.env["GITHUB_API_BASE_URL"];
  });

  async function request(name: string, args: Record<string, unknown>): Promise<RecordedRequest> {
    const stub = serve('{"id":1}');
    await withEnv({ GITHUB_PAT: "ghp_test" }, async () => {
      await tools.call(name, args);
    });
    return stub.only;
  }

  const ISSUE = { owner: "acme", repo: "api", issueNumber: 12 };

  it("issue_comment_create POSTs the body to the issue's comments", async () => {
    const req = await request("github_issue_comment_create", { ...ISSUE, body: "LGTM" });
    expect(`${req.method} ${req.url}`).toBe(`POST ${API}/repos/acme/api/issues/12/comments`);
    expect(JSON.parse(req.body ?? "null")).toEqual({ body: "LGTM" });
    expect(req.headers["authorization"]).toBe("Bearer ghp_test");
    expect(req.headers["content-type"]).toBe("application/json");
  });

  it("issue_labels_add POSTs the labels to the add endpoint, never a replace or delete", async () => {
    const req = await request("github_issue_labels_add", { ...ISSUE, labels: ["bug", "p1"] });
    expect(`${req.method} ${req.url}`).toBe(`POST ${API}/repos/acme/api/issues/12/labels`);
    expect(JSON.parse(req.body ?? "null")).toEqual({ labels: ["bug", "p1"] });
  });

  it("issue_assignees_add POSTs the assignees", async () => {
    const req = await request("github_issue_assignees_add", { ...ISSUE, assignees: ["octo"] });
    expect(`${req.method} ${req.url}`).toBe(`POST ${API}/repos/acme/api/issues/12/assignees`);
    expect(JSON.parse(req.body ?? "null")).toEqual({ assignees: ["octo"] });
  });

  it("issue_state_set PATCHes the state", async () => {
    const req = await request("github_issue_state_set", { ...ISSUE, state: "closed" });
    expect(`${req.method} ${req.url}`).toBe(`PATCH ${API}/repos/acme/api/issues/12`);
    expect(JSON.parse(req.body ?? "null")).toEqual({ state: "closed" });
  });

  it("rejects out-of-range arguments before any request", async () => {
    const stub = serve("{}");
    await withEnv({ GITHUB_PAT: "ghp_test" }, async () => {
      for (const [name, args] of [
        ["github_issue_comment_create", { ...ISSUE, body: "" }],
        ["github_issue_comment_create", { ...ISSUE, body: "x".repeat(65_001) }],
        ["github_issue_comment_create", { ...ISSUE, issueNumber: 0, body: "x" }],
        ["github_issue_labels_add", { ...ISSUE, labels: [] }],
        ["github_issue_labels_add", { ...ISSUE, labels: [""] }],
        ["github_issue_assignees_add", { ...ISSUE, assignees: [] }],
        ["github_issue_assignees_add", { ...ISSUE, assignees: Array(11).fill("a") }],
        ["github_issue_state_set", { ...ISSUE, state: "merged" }],
      ] as const) {
        await expect(tools.call(name, args)).rejects.toThrow();
      }
    });
    expect(stub.calls).toEqual([]);
  });

  it("sends the request to a GitHub Enterprise Server base without doubling its prefix", async () => {
    process.env["GITHUB_API_BASE_URL"] = "https://ghe.example.com/api/v3";
    const req = await request("github_issue_comment_create", { ...ISSUE, body: "hi" });
    expect(req.url).toBe("https://ghe.example.com/api/v3/repos/acme/api/issues/12/comments");
    const list = serve("[]");
    await withEnv({ GITHUB_PAT: "ghp_test" }, async () => {
      await tools.call("github_pr_list", { owner: "acme", repo: "api" });
    });
    expect(list.only.url).toBe(
      "https://ghe.example.com/api/v3/repos/acme/api/pulls?state=open&per_page=30&sort=updated&direction=desc",
    );
  });
});

describe("github branch delete (standalone mode)", () => {
  let auditDir: string;
  let auditLog: string;

  beforeEach(() => {
    setConnectorMode("standalone");
    auditDir = mkdtempSync(join(tmpdir(), "nimbus-github-audit-"));
    auditLog = join(auditDir, "audit.jsonl");
  });

  afterEach(() => {
    rmSync(auditDir, { recursive: true, force: true });
  });

  /** Register for a client that can prompt, with acme/api in scope and the audit log on. */
  async function standalone(): Promise<CapturedTools> {
    let tools: CapturedTools | undefined;
    await withEnv(
      {
        NIMBUS_MCP_GITHUB_WRITE_SCOPE: "repo:acme/api",
        NIMBUS_MCP_AUDIT_LOG: auditLog,
        NIMBUS_MCP_WRITE_BUDGET: undefined,
      },
      () => {
        tools = captureStandaloneTools(registerGithubTools, { elicitation: true }).tools;
      },
    );
    if (tools === undefined) throw new Error("registration did not run");
    return tools;
  }

  /** The `detail` of the audit entry the connector recorded with `outcome`. */
  function audited(outcome: string): Record<string, unknown> | undefined {
    return readFileSync(auditLog, "utf8")
      .trim()
      .split("\n")
      .map(
        (l) =>
          (JSON.parse(l) as { entry: { outcome: string; detail: Record<string, unknown> } }).entry,
      )
      .find((e) => e.outcome === outcome)?.detail;
  }

  it("captures the ref's SHA before deleting it, so the branch can be recreated", async () => {
    const tools = await standalone();
    const ref = '{"ref":"refs/heads/feature/x","object":{"sha":"abc123"}}';
    const stub = serve((req) => (req.method === "GET" ? ref : { status: 204, body: "" }));
    await withEnv({ GITHUB_PAT: "ghp_test" }, async () => {
      expect(
        await tools.callJson("github_branch_delete", {
          owner: "acme",
          repo: "api",
          branch: "feature/x",
        }),
      ).toEqual({ ok: true, deleted: "heads/feature/x" });
    });
    // The read of the ref comes first, then the delete — both on the encoded ref.
    expect(stub.calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      `GET ${API}/repos/acme/api/git/ref/heads%2Ffeature%2Fx`,
      `DELETE ${API}/repos/acme/api/git/refs/heads%2Ffeature%2Fx`,
    ]);
    expect(audited("executed")?.["preState"]).toEqual({
      ref: "heads/feature/x",
      resolved: true,
      sha: JSON.parse(ref) as unknown,
    });
  });

  it("records an unresolved ref when the lookup fails, and still deletes as approved", async () => {
    const tools = await standalone();
    serve((req) =>
      req.method === "GET"
        ? { status: 404, body: '{"message":"Not Found"}' }
        : { status: 204, body: "" },
    );
    await withEnv({ GITHUB_PAT: "ghp_test" }, async () => {
      await tools.call("github_branch_delete", { owner: "acme", repo: "api", branch: "gone" });
    });
    expect(audited("executed")?.["preState"]).toEqual({
      ref: "heads/gone",
      resolved: false,
      sha: { message: "Not Found" },
    });
  });

  it("refuses a branch delete outside the write scope, without reading or deleting", async () => {
    const tools = await standalone();
    const stub = serve("{}");
    await withEnv({ GITHUB_PAT: "ghp_test" }, async () => {
      expect(
        await tools.callJson("github_branch_delete", { owner: "other", repo: "api", branch: "x" }),
      ).toEqual({
        ok: false,
        error: "out of scope: repo:other/api is not in NIMBUS_MCP_GITHUB_WRITE_SCOPE",
      });
    });
    expect(stub.calls).toEqual([]);
  });
});

const SHA = "0123456789abcdef0123456789abcdef01234567";
const SHA2 = "fedcba9876543210fedcba9876543210fedcba98";
const COMMITS = `${API}/repos/acme/api/commits`;
const REPO_ARGS = { owner: "acme", repo: "api" };

/** A reply table keyed `"METHOD url"`; any other request is a failing "unexpected request". */
function table(rows: Record<string, StubReply>): (req: RecordedRequest) => StubReply | undefined {
  return (req) => rows[`${req.method} ${req.url}`];
}

const log = (stub: FetchStub): string[] => stub.calls.map((c) => `${c.method} ${c.url}`);

describe("github branch create / ref get (gateway mode)", () => {
  let tools: CapturedTools;

  beforeEach(() => {
    setConnectorMode("gateway");
    tools = captureTools(registerGithubTools);
  });

  afterEach(() => {
    delete process.env["GITHUB_API_BASE_URL"];
  });

  async function run<T>(fn: () => Promise<T>): Promise<T> {
    return withEnv({ GITHUB_PAT: "ghp_test" }, fn);
  }

  it("resolves a branch name, then POSTs the new ref at that commit", async () => {
    const stub = serve(
      table({
        [`GET ${COMMITS}/heads/main`]: SHA,
        [`POST ${API}/repos/acme/api/git/refs`]: {
          status: 201,
          body: '{"ref":"refs/heads/feat/x"}',
        },
      }),
    );
    const out = await run(() =>
      tools.callJson("github_branch_create", {
        ...REPO_ARGS,
        branch: "feat/x",
        fromRef: "main",
      }),
    );
    expect(out).toEqual({ ok: true, ref: "refs/heads/feat/x", sha: SHA, fromRef: "main" });
    expect(log(stub)).toEqual([`GET ${COMMITS}/heads/main`, `POST ${API}/repos/acme/api/git/refs`]);
    expect(stub.calls[0]?.headers["accept"]).toBe("application/vnd.github.sha");
    expect(stub.calls[0]?.headers["authorization"]).toBe("Bearer ghp_test");
    expect(JSON.parse(stub.calls[1]?.body ?? "null")).toEqual({
      ref: "refs/heads/feat/x",
      sha: SHA,
    });
  });

  it("falls back from heads to tags on a 404 only, and trims the sha body", async () => {
    const stub = serve(
      table({
        [`GET ${COMMITS}/heads/v1`]: { status: 404, body: '{"message":"No commit found"}' },
        [`GET ${COMMITS}/tags/v1`]: `${SHA}\n`,
        [`POST ${API}/repos/acme/api/git/refs`]: { status: 201, body: "{}" },
      }),
    );
    const out = await run(() =>
      tools.callJson("github_branch_create", { ...REPO_ARGS, branch: "rel", fromRef: "v1" }),
    );
    expect((out as { sha: string }).sha).toBe(SHA);
    expect(log(stub).slice(0, 2)).toEqual([`GET ${COMMITS}/heads/v1`, `GET ${COMMITS}/tags/v1`]);
  });

  it("does not fall through to tags on a non-404 error", async () => {
    const stub = serve(table({ [`GET ${COMMITS}/heads/main`]: { status: 500, body: "boom" } }));
    await run(async () => {
      await expect(
        tools.call("github_branch_create", { ...REPO_ARGS, branch: "b", fromRef: "main" }),
      ).rejects.toThrow("500");
    });
    expect(stub.calls).toHaveLength(1);
  });

  it("a heads/ or tags/ prefixed ref is one GET, never retried under the other kind", async () => {
    const stub = serve(
      table({ [`GET ${COMMITS}/heads/feat/a`]: { status: 404, body: '{"message":"nope"}' } }),
    );
    await run(async () => {
      await expect(
        tools.call("github_branch_create", { ...REPO_ARGS, branch: "b", fromRef: "heads/feat/a" }),
      ).rejects.toThrow("404");
    });
    expect(log(stub)).toEqual([`GET ${COMMITS}/heads/feat/a`]);
  });

  it("a 40-hex fromRef is used as given, with no lookup", async () => {
    const stub = serve({ status: 201, body: "{}" });
    await run(() =>
      tools.call("github_branch_create", { ...REPO_ARGS, branch: "b", fromRef: SHA }),
    );
    expect(log(stub)).toEqual([`POST ${API}/repos/acme/api/git/refs`]);
    expect(JSON.parse(stub.only.body ?? "null")).toEqual({ ref: "refs/heads/b", sha: SHA });
  });

  it("refuses a lookup body that is not a 40-hex sha, and sends no POST", async () => {
    const stub = serve(table({ [`GET ${COMMITS}/heads/main`]: "<html>oops</html>" }));
    await run(async () => {
      await expect(
        tools.call("github_branch_create", { ...REPO_ARGS, branch: "b", fromRef: "main" }),
      ).rejects.toThrow(/sha/i);
    });
    expect(stub.calls).toHaveLength(1);
  });

  it("surfaces the 422 body when GitHub refuses the ref", async () => {
    serve(
      table({
        [`GET ${COMMITS}/heads/main`]: SHA,
        [`POST ${API}/repos/acme/api/git/refs`]: {
          status: 422,
          body: '{"message":"Reference already exists"}',
        },
      }),
    );
    await run(async () => {
      await expect(
        tools.call("github_branch_create", { ...REPO_ARGS, branch: "b", fromRef: "main" }),
      ).rejects.toThrow("Reference already exists");
    });
  });

  it("expectedSha: a mismatch throws BEFORE any POST, a match proceeds", async () => {
    const stub = serve(
      table({
        [`GET ${COMMITS}/heads/main`]: SHA,
        [`POST ${API}/repos/acme/api/git/refs`]: { status: 201, body: "{}" },
      }),
    );
    await run(async () => {
      await expect(
        tools.call("github_branch_create", {
          ...REPO_ARGS,
          branch: "b",
          fromRef: "main",
          expectedSha: SHA2,
        }),
      ).rejects.toThrow(`fromRef resolves to ${SHA}, not the approved ${SHA2}`);
    });
    expect(log(stub)).toEqual([`GET ${COMMITS}/heads/main`]);
    await run(() =>
      tools.call("github_branch_create", {
        ...REPO_ARGS,
        branch: "b",
        fromRef: "main",
        expectedSha: SHA,
      }),
    );
    expect(log(stub).filter((l) => l.startsWith("POST"))).toHaveLength(1);
  });

  it("refuses an expectedSha that is not 40 hex", async () => {
    const stub = serve("{}");
    await run(async () => {
      await expect(
        tools.call("github_branch_create", {
          ...REPO_ARGS,
          branch: "b",
          fromRef: "main",
          expectedSha: "abc",
        }),
      ).rejects.toThrow();
    });
    expect(stub.calls).toEqual([]);
  });

  const BAD_REFS = [
    "../x",
    "a/../b",
    "a..b",
    "/x",
    "x/",
    "a//b",
    "a\u0001b",
    "a b",
    "a\nb",
    "x?y=1",
    "a+b",
    "a/.hidden",
    "a/b.lock",
    "-x",
    "refs/../../etc",
    "a%2e%2e/b",
    "x".repeat(256),
    "",
  ];

  it("refuses an unsafe fromRef, branch or ref before any request", async () => {
    const stub = serve("{}");
    await run(async () => {
      for (const bad of BAD_REFS) {
        await expect(
          tools.call("github_branch_create", { ...REPO_ARGS, branch: "ok", fromRef: bad }),
        ).rejects.toThrow();
        await expect(
          tools.call("github_branch_create", { ...REPO_ARGS, branch: bad, fromRef: "main" }),
        ).rejects.toThrow();
        await expect(tools.call("github_ref_get", { ...REPO_ARGS, ref: bad })).rejects.toThrow();
      }
    });
    expect(stub.calls).toEqual([]);
  });

  it("sends nothing at all when GITHUB_PAT is missing", async () => {
    const stub = serve("{}");
    await expect(
      tools.call("github_branch_create", { ...REPO_ARGS, branch: "b", fromRef: "main" }),
    ).rejects.toThrow("GITHUB_PAT");
    expect(stub.calls).toEqual([]);
  });

  it("honours a GitHub Enterprise Server base without doubling /api/v3", async () => {
    process.env["GITHUB_API_BASE_URL"] = "https://ghe.example.com/api/v3";
    const stub = serve(
      table({
        "GET https://ghe.example.com/api/v3/repos/acme/api/commits/heads/main": SHA,
        "POST https://ghe.example.com/api/v3/repos/acme/api/git/refs": { status: 201, body: "{}" },
      }),
    );
    await run(() =>
      tools.call("github_branch_create", { ...REPO_ARGS, branch: "b", fromRef: "main" }),
    );
    expect(stub.calls).toHaveLength(2);
  });

  it("ref_get reports a branch, a tag, and a sha", async () => {
    serve(
      table({
        [`GET ${COMMITS}/heads/main`]: SHA,
        [`GET ${COMMITS}/tags/v2`]: SHA2,
        [`GET ${COMMITS}/heads/v2`]: { status: 404, body: "{}" },
      }),
    );
    await run(async () => {
      expect(await tools.callJson("github_ref_get", { ...REPO_ARGS, ref: "heads/main" })).toEqual({
        ref: "heads/main",
        kind: "branch",
        sha: SHA,
      });
      expect(await tools.callJson("github_ref_get", { ...REPO_ARGS, ref: "v2" })).toEqual({
        ref: "v2",
        kind: "tag",
        sha: SHA2,
      });
      expect(await tools.callJson("github_ref_get", { ...REPO_ARGS, ref: SHA })).toEqual({
        ref: SHA,
        kind: "sha",
        sha: SHA,
      });
    });
  });

  it("ref_get on an unknown ref throws naming the ref", async () => {
    serve({ status: 404, body: '{"message":"No commit found for the ref ghost"}' });
    await run(async () => {
      await expect(tools.call("github_ref_get", { ...REPO_ARGS, ref: "ghost" })).rejects.toThrow(
        "ghost",
      );
    });
  });
});

describe("github pr create / update (gateway mode)", () => {
  let tools: CapturedTools;

  beforeEach(() => {
    setConnectorMode("gateway");
    tools = captureTools(registerGithubTools);
  });

  async function request(name: string, args: Record<string, unknown>): Promise<RecordedRequest> {
    const stub = serve('{"number":9}');
    await withEnv({ GITHUB_PAT: "ghp_test" }, async () => {
      await tools.call(name, args);
    });
    return stub.only;
  }

  const MARKDOWN = "Ping @channel\n/close\n![](https://x/y.png)\n";

  it("pr_create POSTs head, base and title, with absent keys absent", async () => {
    const req = await request("github_pr_create", {
      ...REPO_ARGS,
      head: "feat/x",
      base: "main",
      title: "Add x",
    });
    expect(`${req.method} ${req.url}`).toBe(`POST ${API}/repos/acme/api/pulls`);
    expect(JSON.parse(req.body ?? "null")).toEqual({
      head: "feat/x",
      base: "main",
      title: "Add x",
    });
    expect(req.headers["content-type"]).toBe("application/json");
  });

  it("pr_create sends draft:false when given and a cross-repo head as given", async () => {
    const req = await request("github_pr_create", {
      ...REPO_ARGS,
      head: "fork:feat/x",
      base: "main",
      title: "t",
      draft: false,
    });
    expect(JSON.parse(req.body ?? "null")).toEqual({
      head: "fork:feat/x",
      base: "main",
      title: "t",
      draft: false,
    });
  });

  it("pr_create sends title and body byte-identical, mentions and quick actions included", async () => {
    const req = await request("github_pr_create", {
      ...REPO_ARGS,
      head: "h",
      base: "b",
      title: "Fix @channel /close",
      body: MARKDOWN,
    });
    const sent = JSON.parse(req.body ?? "null") as { title: string; body: string };
    expect(sent.body).toBe(MARKDOWN);
    expect(sent.title).toBe("Fix @channel /close");
  });

  it("pr_create refuses an empty title or an over-long title or body before any request", async () => {
    const stub = serve("{}");
    await withEnv({ GITHUB_PAT: "ghp_test" }, async () => {
      for (const bad of [{ title: "" }, { title: "x".repeat(257) }, { body: "x".repeat(65_001) }]) {
        await expect(
          tools.call("github_pr_create", {
            ...REPO_ARGS,
            head: "h",
            base: "b",
            title: "t",
            ...bad,
          }),
        ).rejects.toThrow();
      }
    });
    expect(stub.calls).toEqual([]);
  });

  it("pr_update PATCHes only the keys it is given, and never state", async () => {
    const req = await request("github_pr_update", {
      ...REPO_ARGS,
      pullNumber: 9,
      title: "New title",
    });
    expect(`${req.method} ${req.url}`).toBe(`PATCH ${API}/repos/acme/api/pulls/9`);
    expect(JSON.parse(req.body ?? "null")).toEqual({ title: "New title" });
    const all = await request("github_pr_update", {
      ...REPO_ARGS,
      pullNumber: 9,
      title: "t",
      body: MARKDOWN,
      base: "develop",
      state: "closed",
    });
    const sent = JSON.parse(all.body ?? "null") as Record<string, unknown>;
    expect(sent).toEqual({ title: "t", body: MARKDOWN, base: "develop" });
    expect("state" in sent).toBe(false);
  });

  it("pr_update with none of title, body, base is refused before any request", async () => {
    const stub = serve("{}");
    await withEnv({ GITHUB_PAT: "ghp_test" }, async () => {
      await expect(tools.call("github_pr_update", { ...REPO_ARGS, pullNumber: 9 })).rejects.toThrow(
        "at least one of title, body, base",
      );
    });
    expect(stub.calls).toEqual([]);
  });

  it("pr_update registers a plain object schema that lists its fields", () => {
    const schema = tools.get("github_pr_update").schema as { shape?: Record<string, unknown> };
    expect(Object.keys(schema.shape ?? {}).sort((a, b) => a.localeCompare(b))).toEqual([
      "base",
      "body",
      "owner",
      "pullNumber",
      "repo",
      "title",
    ]);
  });

  it("pr_update refuses pullNumber 0", async () => {
    const stub = serve("{}");
    await withEnv({ GITHUB_PAT: "ghp_test" }, async () => {
      await expect(
        tools.call("github_pr_update", { ...REPO_ARGS, pullNumber: 0, title: "t" }),
      ).rejects.toThrow();
    });
    expect(stub.calls).toEqual([]);
  });
});

describe("github branch create / pr update (standalone mode)", () => {
  let auditDir: string;
  let auditLog: string;

  beforeEach(() => {
    setConnectorMode("standalone");
    auditDir = mkdtempSync(join(tmpdir(), "nimbus-github-audit-"));
    auditLog = join(auditDir, "audit.jsonl");
  });

  afterEach(() => {
    rmSync(auditDir, { recursive: true, force: true });
  });

  async function standalone(elicitation = true): Promise<CapturedTools> {
    let tools: CapturedTools | undefined;
    await withEnv(
      {
        NIMBUS_MCP_GITHUB_WRITE_SCOPE: "repo:acme/api",
        NIMBUS_MCP_AUDIT_LOG: auditLog,
        NIMBUS_MCP_WRITE_BUDGET: undefined,
      },
      () => {
        tools = captureStandaloneTools(registerGithubTools, { elicitation }).tools;
      },
    );
    if (tools === undefined) throw new Error("registration did not run");
    return tools;
  }

  function audited(outcome: string): Record<string, unknown> | undefined {
    return readFileSync(auditLog, "utf8")
      .trim()
      .split("\n")
      .map(
        (l) =>
          (JSON.parse(l) as { entry: { outcome: string; detail: Record<string, unknown> } }).entry,
      )
      .find((e) => e.outcome === outcome)?.detail;
  }

  it("captures the PR's title, body and base BEFORE the PATCH", async () => {
    const tools = await standalone();
    const pr = JSON.stringify({ title: "Old", body: "old body", base: { ref: "main" }, extra: 1 });
    const stub = serve((req) => (req.method === "GET" ? pr : '{"number":9}'));
    await withEnv({ GITHUB_PAT: "ghp_test" }, async () => {
      await tools.call("github_pr_update", { ...REPO_ARGS, pullNumber: 9, title: "New" });
    });
    expect(log(stub)).toEqual([
      `GET ${API}/repos/acme/api/pulls/9`,
      `PATCH ${API}/repos/acme/api/pulls/9`,
    ]);
    expect(audited("executed")?.["preState"]).toEqual({
      title: "Old",
      body: "old body",
      base: "main",
    });
  });

  it("is out of scope for another repo, with no read and no write", async () => {
    const tools = await standalone();
    const stub = serve("{}");
    await withEnv({ GITHUB_PAT: "ghp_test" }, async () => {
      expect(
        await tools.callJson("github_pr_update", {
          owner: "other",
          repo: "api",
          pullNumber: 1,
          title: "t",
        }),
      ).toEqual({
        ok: false,
        error: "out of scope: repo:other/api is not in NIMBUS_MCP_GITHUB_WRITE_SCOPE",
      });
    });
    expect(stub.calls).toEqual([]);
  });

  it("registers github_ref_get as a read and the writes only for a client that can prompt", async () => {
    const writes = ["github_branch_create", "github_pr_create", "github_pr_update"];
    const legacy = (await standalone(false)).names();
    expect(legacy).toContain("github_ref_get");
    for (const w of writes) {
      expect(legacy).not.toContain(w);
    }
    const capable = (await standalone(true)).names();
    for (const w of writes) {
      expect(capable).toContain(w);
    }
  });
});

describe("github owner and repo (path confusion)", () => {
  let tools: CapturedTools;

  beforeEach(() => {
    setConnectorMode("gateway");
    tools = captureTools(registerGithubTools);
  });

  it("refuses dot segments, slashes and odd characters before any request", async () => {
    const stub = serve("{}");
    await withEnv({ GITHUB_PAT: "ghp_test" }, async () => {
      for (const bad of [".", "..", "a/b", "a b", "a?b", "a%2fb", "", "x".repeat(101), "a​b"]) {
        await expect(tools.call("github_repo_get", { owner: bad, repo: "r" })).rejects.toThrow();
        await expect(tools.call("github_repo_get", { owner: "o", repo: bad })).rejects.toThrow();
        await expect(
          tools.call("github_pr_update", { owner: bad, repo: "r", pullNumber: 1, title: "t" }),
        ).rejects.toThrow();
      }
    });
    expect(stub.calls).toEqual([]);
  });

  it("still accepts ordinary names, dots and underscores", async () => {
    const stub = serve("{}");
    await withEnv({ GITHUB_PAT: "ghp_test" }, async () => {
      await tools.call("github_repo_get", { owner: "my-org", repo: "my_repo.js" });
    });
    expect(stub.only.url).toBe(`${API}/repos/my-org/my_repo.js`);
  });
});
