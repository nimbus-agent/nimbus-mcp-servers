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
import { registerGitlabTools } from "../src/tools.ts";

const BASE_ENV = "GITLAB_API_BASE_URL";
const API = "https://gitlab.com/api/v4";
const ENC = `${API}/projects/group%2Frepo`;
const PROJECT = { projectPath: "group/repo" };

let http: FetchStub | undefined;

function serve(reply: StubReply | ((req: RecordedRequest) => StubReply | undefined)): FetchStub {
  http?.restore();
  http = stubFetch(reply);
  return http;
}

beforeEach(() => {
  resetConnectorModeForTests();
  delete process.env[BASE_ENV];
  process.env["GITLAB_PAT"] = "glpat-test";
});

afterEach(() => {
  http?.restore();
  http = undefined;
  delete process.env["GITLAB_PAT"];
  delete process.env[BASE_ENV];
  resetConnectorModeForTests();
});

describe("gitlab branch, merge request create and update (gateway mode)", () => {
  let tools: CapturedTools;

  beforeEach(() => {
    setConnectorMode("gateway");
    tools = captureTools(registerGitlabTools);
  });

  async function request(name: string, args: Record<string, unknown>): Promise<RecordedRequest> {
    const stub = serve('{"iid":5}');
    await tools.call(name, { ...PROJECT, ...args });
    return stub.only;
  }

  it("branch_create POSTs branch then ref as query parameters, with no body", async () => {
    const req = await request("gitlab_branch_create", { branch: "feat/x", fromRef: "main" });
    expect(`${req.method} ${req.url}`).toBe(
      `POST ${ENC}/repository/branches?branch=feat%2Fx&ref=main`,
    );
    expect(req.body).toBeUndefined();
    expect(req.headers["private-token"]).toBe("glpat-test");
  });

  it("branch_create accepts a commit sha as fromRef", async () => {
    const sha = "0123456789abcdef0123456789abcdef01234567";
    const req = await request("gitlab_branch_create", { branch: "b", fromRef: sha });
    expect(req.url).toBe(`${ENC}/repository/branches?branch=b&ref=${sha}`);
  });

  it("branch_create refuses names GitLab would reject or that smuggle syntax, before any request", async () => {
    const stub = serve("{}");
    for (const bad of ["a b", "-x", "a..b", "a\u0001b", "a\nb", "", "x".repeat(256)]) {
      await expect(
        tools.call("gitlab_branch_create", { ...PROJECT, branch: bad, fromRef: "main" }),
      ).rejects.toThrow();
      await expect(
        tools.call("gitlab_branch_create", { ...PROJECT, branch: "ok", fromRef: bad }),
      ).rejects.toThrow();
    }
    expect(stub.calls).toEqual([]);
  });

  it("branch_create refuses a query-hostile branch name instead of encoding it", async () => {
    const stub = serve("{}");
    await expect(
      tools.call("gitlab_branch_create", { ...PROJECT, branch: "a&b=c", fromRef: "main" }),
    ).rejects.toThrow();
    expect(stub.calls).toEqual([]);
  });

  it("mr_create POSTs exactly the documented fields, absent keys absent", async () => {
    const req = await request("gitlab_mr_create", {
      sourceBranch: "feat/x",
      targetBranch: "main",
      title: "Add x",
    });
    expect(`${req.method} ${req.url}`).toBe(`POST ${ENC}/merge_requests`);
    expect(JSON.parse(req.body ?? "null")).toEqual({
      source_branch: "feat/x",
      target_branch: "main",
      title: "Add x",
    });
    expect(req.headers["content-type"]).toBe("application/json");
  });

  const MARKDOWN = "Ping @channel\n/close\n![](https://x/y.png)\n";

  it("mr_create sends title and description byte-identical", async () => {
    const req = await request("gitlab_mr_create", {
      sourceBranch: "a",
      targetBranch: "b",
      title: "Fix @channel /close",
      description: MARKDOWN,
    });
    const sent = JSON.parse(req.body ?? "null") as Record<string, string>;
    expect(sent["description"]).toBe(MARKDOWN);
    expect(sent["title"]).toBe("Fix @channel /close");
    expect(Object.keys(sent).sort((a, b) => a.localeCompare(b))).toEqual([
      "description",
      "source_branch",
      "target_branch",
      "title",
    ]);
  });

  it("mr_create encodes a nested project path and honours a base override without doubling", async () => {
    process.env[BASE_ENV] = "https://git.example.com/api/v4/";
    const stub = serve("{}");
    await tools.call("gitlab_mr_create", {
      projectPath: "group/sub/repo",
      sourceBranch: "a",
      targetBranch: "b",
      title: "t",
    });
    expect(stub.only.url).toBe(
      "https://git.example.com/api/v4/projects/group%2Fsub%2Frepo/merge_requests",
    );
  });

  it("mr_create refuses an empty title or an over-long description before any request", async () => {
    const stub = serve("{}");
    for (const bad of [
      { title: "" },
      { title: "x".repeat(256) },
      { description: "x".repeat(65_001) },
    ]) {
      await expect(
        tools.call("gitlab_mr_create", {
          ...PROJECT,
          sourceBranch: "a",
          targetBranch: "b",
          title: "t",
          ...bad,
        }),
      ).rejects.toThrow();
    }
    expect(stub.calls).toEqual([]);
  });

  it("mr_update PUTs only the keys given, and never state_event", async () => {
    const req = await request("gitlab_mr_update", { mergeRequestIid: 4, title: "New" });
    expect(`${req.method} ${req.url}`).toBe(`PUT ${ENC}/merge_requests/4`);
    expect(JSON.parse(req.body ?? "null")).toEqual({ title: "New" });
    const all = await request("gitlab_mr_update", {
      mergeRequestIid: 4,
      title: "t",
      description: MARKDOWN,
      targetBranch: "develop",
      stateEvent: "close",
    });
    const sent = JSON.parse(all.body ?? "null") as Record<string, unknown>;
    expect(sent).toEqual({ title: "t", description: MARKDOWN, target_branch: "develop" });
    expect("state_event" in sent).toBe(false);
  });

  it("mr_update with none of title, description, targetBranch is refused before any request", async () => {
    const stub = serve("{}");
    await expect(
      tools.call("gitlab_mr_update", { ...PROJECT, mergeRequestIid: 4 }),
    ).rejects.toThrow("at least one of title, description, targetBranch");
    expect(stub.calls).toEqual([]);
  });

  it("mr_update registers a plain object schema that lists its fields", () => {
    const schema = tools.get("gitlab_mr_update").schema as { shape?: Record<string, unknown> };
    expect(Object.keys(schema.shape ?? {}).sort((a, b) => a.localeCompare(b))).toEqual([
      "description",
      "mergeRequestIid",
      "projectPath",
      "targetBranch",
      "title",
    ]);
  });

  it("sends nothing at all when GITLAB_PAT is missing", async () => {
    delete process.env["GITLAB_PAT"];
    const stub = serve("{}");
    for (const [name, args] of [
      ["gitlab_branch_create", { branch: "b", fromRef: "main" }],
      ["gitlab_mr_create", { sourceBranch: "a", targetBranch: "b", title: "t" }],
      ["gitlab_mr_update", { mergeRequestIid: 1, title: "t" }],
    ] as const) {
      await expect(tools.call(name, { ...PROJECT, ...args })).rejects.toThrow("GITLAB_PAT");
    }
    expect(stub.calls).toEqual([]);
  });
});

describe("gitlab mr_update (standalone mode)", () => {
  let auditDir: string;
  let auditLog: string;

  beforeEach(() => {
    setConnectorMode("standalone");
    auditDir = mkdtempSync(join(tmpdir(), "nimbus-gitlab-audit-"));
    auditLog = join(auditDir, "audit.jsonl");
  });

  afterEach(() => {
    rmSync(auditDir, { recursive: true, force: true });
  });

  async function standalone(): Promise<CapturedTools> {
    let tools: CapturedTools | undefined;
    await withEnv(
      {
        NIMBUS_MCP_GITLAB_WRITE_SCOPE: "repo:group/repo",
        NIMBUS_MCP_AUDIT_LOG: auditLog,
        NIMBUS_MCP_WRITE_BUDGET: undefined,
      },
      () => {
        tools = captureStandaloneTools(registerGitlabTools, { elicitation: true }).tools;
      },
    );
    if (tools === undefined) throw new Error("registration did not run");
    return tools;
  }

  it("captures the merge request's title, description and target BEFORE the PUT", async () => {
    const tools = await standalone();
    const mr = JSON.stringify({
      title: "Old",
      description: "old text",
      target_branch: "main",
      other: 1,
    });
    const stub = serve((req) => (req.method === "GET" ? mr : "{}"));
    await tools.call("gitlab_mr_update", { ...PROJECT, mergeRequestIid: 4, title: "New" });
    expect(stub.calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      `GET ${ENC}/merge_requests/4`,
      `PUT ${ENC}/merge_requests/4`,
    ]);
    const executed = readFileSync(auditLog, "utf8")
      .trim()
      .split("\n")
      .map(
        (l) =>
          (JSON.parse(l) as { entry: { outcome: string; detail: Record<string, unknown> } }).entry,
      )
      .find((e) => e.outcome === "executed");
    expect(executed?.detail["preState"]).toEqual({
      title: "Old",
      description: "old text",
      target_branch: "main",
    });
  });
});

describe("gitlab never sends its token across origins", () => {
  let tools: CapturedTools;
  const EVIL = "https://evil.example/steal";

  beforeEach(() => {
    setConnectorMode("gateway");
    tools = captureTools(registerGitlabTools);
  });

  /** Every request the stub saw that carried any credential header. */
  const credentialed = (stub: FetchStub): string[] =>
    stub.calls
      .filter(
        (c) => c.headers["private-token"] !== undefined || c.headers["authorization"] !== undefined,
      )
      .map((c) => c.url);

  it("a cross-origin 307 on a POST throws and the second request is never made", async () => {
    const stub = serve({ status: 307, headers: { Location: EVIL } });
    await expect(
      tools.call("gitlab_mr_create", {
        ...PROJECT,
        sourceBranch: "a",
        targetBranch: "b",
        title: "t",
      }),
    ).rejects.toThrow(/GitLab answered a POST with a redirect \(307\); the write may or may not have been applied/);
    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0]?.redirect).toBe("manual");
  });

  it("a same-origin 307 on a write is refused too", async () => {
    const stub = serve({ status: 307, headers: { Location: `${API}/elsewhere` } });
    await expect(
      tools.call("gitlab_pipeline_retry", { ...PROJECT, pipelineId: 1 }),
    ).rejects.toThrow(/answered a POST with a redirect \(307\)/);
    expect(stub.calls).toHaveLength(1);
  });

  it("a cross-origin 302 on a GET throws, and no request to another origin carries a credential", async () => {
    const stub = serve({ status: 302, headers: { Location: EVIL } });
    await expect(tools.call("gitlab_mr_get", { ...PROJECT, mergeRequestIid: 1 })).rejects.toThrow(
      "GitLab redirected to another origin; refused",
    );
    expect(stub.calls).toHaveLength(1);
    expect(credentialed(stub).every((u) => new URL(u).origin === "https://gitlab.com")).toBe(true);
    expect(stub.calls.some((c) => c.url.startsWith("https://evil.example"))).toBe(false);
  });

  it("a same-origin https 301 on a GET is followed, with the token", async () => {
    const stub = serve((req) =>
      req.url.includes("group%2Frepo")
        ? { status: 301, headers: { Location: `${API}/projects/123/merge_requests/1` } }
        : '{"iid":1}',
    );
    expect(await tools.callJson("gitlab_mr_get", { ...PROJECT, mergeRequestIid: 1 })).toEqual({
      iid: 1,
    });
    expect(stub.calls).toHaveLength(2);
    expect(stub.calls[1]?.url).toBe(`${API}/projects/123/merge_requests/1`);
    expect(stub.calls[1]?.headers["private-token"]).toBe("glpat-test");
  });

  it("a relative Location resolves against the current URL and is followed", async () => {
    const stub = serve((req) =>
      req.url.includes("group%2Frepo")
        ? { status: 302, headers: { Location: "/api/v4/moved" } }
        : "{}",
    );
    await tools.call("gitlab_mr_get", { ...PROJECT, mergeRequestIid: 1 });
    expect(stub.calls[1]?.url).toBe("https://gitlab.com/api/v4/moved");
  });

  it("an http: Location is refused", async () => {
    const stub = serve({ status: 301, headers: { Location: "http://gitlab.com/api/v4/x" } });
    await expect(tools.call("gitlab_mr_get", { ...PROJECT, mergeRequestIid: 1 })).rejects.toThrow(
      "redirected to another origin; refused",
    );
    expect(stub.calls).toHaveLength(1);
  });

  it("a redirect with no Location is refused rather than returned as a result", async () => {
    serve({ status: 302 });
    await expect(tools.call("gitlab_mr_get", { ...PROJECT, mergeRequestIid: 1 })).rejects.toThrow(
      /redirect/,
    );
  });

  it("a fourth hop is refused", async () => {
    const stub = serve({ status: 301, headers: { Location: `${API}/loop` } });
    await expect(tools.call("gitlab_mr_get", { ...PROJECT, mergeRequestIid: 1 })).rejects.toThrow(
      /too many redirects/,
    );
    expect(stub.calls).toHaveLength(4);
  });

  it("the job trace fetch refuses a cross-origin redirect", async () => {
    const stub = serve({ status: 302, headers: { Location: EVIL } });
    await expect(tools.call("gitlab_job_trace", { ...PROJECT, jobId: 7 })).rejects.toThrow(
      "redirected to another origin; refused",
    );
    expect(stub.calls).toHaveLength(1);
  });

  it("the GraphQL assignee POST refuses any redirect", async () => {
    const stub = serve({ status: 307, headers: { Location: EVIL } });
    await expect(
      tools.call("gitlab_issue_assignees_add", {
        ...PROJECT,
        issueIid: 3,
        assigneeUsernames: ["ada"],
      }),
    ).rejects.toThrow(/answered a POST with a redirect \(307\)/);
    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0]?.redirect).toBe("manual");
  });

  it("works against a self-hosted plain-http base (no refusal before the request)", async () => {
    process.env[BASE_ENV] = "http://gitlab.example.com/api/v4";
    const stub = serve("{}");
    await tools.call("gitlab_mr_get", { ...PROJECT, mergeRequestIid: 1 });
    expect(stub.only.url).toBe(
      "http://gitlab.example.com/api/v4/projects/group%2Frepo/merge_requests/1",
    );
  });

  it("follows a same-host http -> https upgrade on a GET, and not to another host", async () => {
    process.env[BASE_ENV] = "http://gitlab.example.com/api/v4";
    const stub = serve((req) =>
      req.url.startsWith("http://")
        ? { status: 301, headers: { Location: req.url.replace("http://", "https://") } }
        : { status: 200, body: "{}" },
    );
    await tools.call("gitlab_mr_get", { ...PROJECT, mergeRequestIid: 1 });
    expect(stub.calls.map((c) => c.url.slice(0, 5))).toEqual(["http:", "https"]);
    const other = serve({ status: 301, headers: { Location: "https://evil.example/x" } });
    await expect(tools.call("gitlab_mr_get", { ...PROJECT, mergeRequestIid: 1 })).rejects.toThrow(
      "another origin",
    );
    expect(other.calls).toHaveLength(1);
  });

  it("still allows a loopback http base", async () => {
    process.env[BASE_ENV] = "http://localhost:9/api/v4";
    const stub = serve("{}");
    await tools.call("gitlab_mr_get", { ...PROJECT, mergeRequestIid: 1 });
    expect(stub.only.url).toBe("http://localhost:9/api/v4/projects/group%2Frepo/merge_requests/1");
  });
});

describe("gitlab branch_create ref rules and expectedSha", () => {
  let tools: CapturedTools;
  const SHA = "0123456789abcdef0123456789abcdef01234567";
  const OTHER = "fedcba9876543210fedcba9876543210fedcba98";

  beforeEach(() => {
    setConnectorMode("gateway");
    tools = captureTools(registerGitlabTools);
  });

  it("refuses refs isSafeGitRef refuses, and invisible or control characters", async () => {
    const stub = serve("{}");
    const bad = [
      "a/",
      "/a",
      "a//b",
      ".hidden",
      "a/.b",
      "x.lock",
      "a.",
      "café",
      "a​b",
      "a‮b",
      "a\u0085b",
      "a\ud800b",
      "a:b",
      "a~b",
      "a^b",
      "a*b",
      "a@{b",
    ];
    for (const b of bad) {
      await expect(
        tools.call("gitlab_branch_create", { ...PROJECT, branch: b, fromRef: "main" }),
      ).rejects.toThrow();
      await expect(
        tools.call("gitlab_branch_create", { ...PROJECT, branch: "ok", fromRef: b }),
      ).rejects.toThrow();
    }
    expect(stub.calls).toEqual([]);
  });

  it("creates from the resolved sha when expectedSha matches", async () => {
    const stub = serve((req) =>
      req.method === "GET" ? JSON.stringify({ id: SHA }) : '{"name":"b"}',
    );
    await tools.call("gitlab_branch_create", {
      ...PROJECT,
      branch: "feat/x",
      fromRef: "rel/1",
      expectedSha: SHA.toUpperCase(),
    });
    expect(stub.calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      `GET ${ENC}/repository/commits/rel%2F1`,
      `POST ${ENC}/repository/branches?branch=feat%2Fx&ref=${SHA}`,
    ]);
  });

  it("refuses before the POST when the ref no longer resolves to expectedSha", async () => {
    const stub = serve((req) => (req.method === "GET" ? JSON.stringify({ id: OTHER }) : "{}"));
    await expect(
      tools.call("gitlab_branch_create", {
        ...PROJECT,
        branch: "b",
        fromRef: "main",
        expectedSha: SHA,
      }),
    ).rejects.toThrow(/resolves to .* not the approved/);
    expect(stub.calls.map((c) => c.method)).toEqual(["GET"]);
  });

  it("refuses when the ref cannot be resolved, and sends no POST", async () => {
    const stub = serve({ status: 404, body: '{"message":"404 Commit Not Found"}' });
    await expect(
      tools.call("gitlab_branch_create", {
        ...PROJECT,
        branch: "b",
        fromRef: "gone",
        expectedSha: SHA,
      }),
    ).rejects.toThrow(/404/);
    expect(stub.calls.map((c) => c.method)).toEqual(["GET"]);
  });

  it("rejects a malformed expectedSha before any request", async () => {
    const stub = serve("{}");
    await expect(
      tools.call("gitlab_branch_create", {
        ...PROJECT,
        branch: "b",
        fromRef: "main",
        expectedSha: "abc",
      }),
    ).rejects.toThrow();
    expect(stub.calls).toEqual([]);
  });
});

it("mr_create and mr_update refuse invisible or control characters in a branch name", async () => {
  setConnectorMode("gateway");
  const t = captureTools(registerGitlabTools);
  const stub = serve("{}");
  for (const bad of ["a​b", "a‮b", "a\u0007b", "a\ud800b"]) {
    await expect(
      t.call("gitlab_mr_create", {
        ...PROJECT,
        sourceBranch: bad,
        targetBranch: "main",
        title: "t",
      }),
    ).rejects.toThrow();
    await expect(
      t.call("gitlab_mr_update", { ...PROJECT, mergeRequestIid: 1, targetBranch: bad }),
    ).rejects.toThrow();
  }
  expect(stub.calls).toEqual([]);
});

describe("gitlab project path (path confusion)", () => {
  let tools: CapturedTools;

  beforeEach(() => {
    setConnectorMode("gateway");
    tools = captureTools(registerGitlabTools);
  });

  it("refuses dot segments and odd characters in any segment, before any request", async () => {
    const stub = serve("{}");
    for (const bad of [
      "..",
      ".",
      "group/..",
      "../x",
      "a/./b",
      "a//b",
      "a b/c",
      "a?b",
      "/a",
      "a/",
      "a%2fb",
    ]) {
      await expect(
        tools.call("gitlab_mr_get", { projectPath: bad, mergeRequestIid: 1 }),
      ).rejects.toThrow();
      await expect(
        tools.call("gitlab_mr_update", { projectPath: bad, mergeRequestIid: 1, title: "t" }),
      ).rejects.toThrow();
    }
    expect(stub.calls).toEqual([]);
  });

  it("accepts a numeric id, a nested group path and dotted names", async () => {
    const stub = serve("{}");
    await tools.call("gitlab_mr_get", { projectPath: "42", mergeRequestIid: 1 });
    await tools.call("gitlab_mr_get", {
      projectPath: "g/sub.group/my_repo.js",
      mergeRequestIid: 1,
    });
    expect(stub.calls.map((c) => c.url)).toEqual([
      `${API}/projects/42/merge_requests/1`,
      `${API}/projects/g%2Fsub.group%2Fmy_repo.js/merge_requests/1`,
    ]);
  });
});
