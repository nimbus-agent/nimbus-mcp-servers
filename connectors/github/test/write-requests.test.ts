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
