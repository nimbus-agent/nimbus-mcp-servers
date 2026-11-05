import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  type CapturedTools,
  captureTools,
  type FetchStub,
  type StubReply,
  stubFetch,
} from "../../../scripts/connector-tool-harness.ts";
import { resetConnectorModeForTests, setConnectorMode } from "../../../shared/connector-mode.ts";
import { registerGitlabTools } from "../src/tools.ts";

const BASE_ENV = "GITLAB_API_BASE_URL";

let tools: CapturedTools;
let fetchStub: FetchStub | undefined;
let savedBase: string | undefined;

/** Answer every request with `r`, replacing (and restoring) any stub already installed. */
function reply(r: StubReply): FetchStub {
  fetchStub?.restore();
  fetchStub = stubFetch(r);
  return fetchStub;
}

beforeEach(() => {
  resetConnectorModeForTests();
  setConnectorMode("gateway");
  savedBase = process.env[BASE_ENV];
  delete process.env[BASE_ENV];
  process.env["GITLAB_PAT"] = "glpat-test";
  tools = captureTools(registerGitlabTools);
});

afterEach(() => {
  fetchStub?.restore();
  fetchStub = undefined;
  delete process.env["GITLAB_PAT"];
  if (savedBase === undefined) {
    delete process.env[BASE_ENV];
  } else {
    process.env[BASE_ENV] = savedBase;
  }
  resetConnectorModeForTests();
});

/** The one URL a tool call requested. */
async function urlOf(name: string, args: Record<string, unknown>): Promise<string> {
  const stub = reply("[]");
  await tools.call(name, args);
  return stub.only.url;
}

const PROJECT = { projectPath: "group/repo" };
const API = "https://gitlab.com/api/v4";

describe("gitlab list tools build an absolute, paged URL in a stable parameter order", () => {
  it("gitlab_project_list: membership and activity order, then paging", async () => {
    expect(await urlOf("gitlab_project_list", {})).toBe(
      `${API}/projects?membership=true&order_by=last_activity_at&sort=desc&per_page=30`,
    );
    expect(await urlOf("gitlab_project_list", { perPage: 5, page: 2 })).toBe(
      `${API}/projects?membership=true&order_by=last_activity_at&sort=desc&per_page=5&page=2`,
    );
  });

  it("does not re-prefix a self-hosted base that carries its own /api/v4", async () => {
    process.env[BASE_ENV] = "https://gl.example.com/api/v4/";
    expect(await urlOf("gitlab_project_list", {})).toBe(
      "https://gl.example.com/api/v4/projects?membership=true&order_by=last_activity_at&sort=desc&per_page=30",
    );
  });

  it("gitlab_mr_list: state (default opened), then paging", async () => {
    expect(await urlOf("gitlab_mr_list", PROJECT)).toBe(
      `${API}/projects/group%2Frepo/merge_requests?state=opened&per_page=30`,
    );
    expect(await urlOf("gitlab_mr_list", { ...PROJECT, state: "merged", page: 3 })).toBe(
      `${API}/projects/group%2Frepo/merge_requests?state=merged&per_page=30&page=3`,
    );
  });

  it("gitlab_issue_list: the same query as the MR list, against issues", async () => {
    expect(await urlOf("gitlab_issue_list", { ...PROJECT, state: "closed", perPage: 7 })).toBe(
      `${API}/projects/group%2Frepo/issues?state=closed&per_page=7`,
    );
  });

  it("gitlab_pipeline_list: paging, then each filter that was given", async () => {
    expect(await urlOf("gitlab_pipeline_list", PROJECT)).toBe(
      `${API}/projects/group%2Frepo/pipelines?per_page=30`,
    );
    expect(
      await urlOf("gitlab_pipeline_list", { ...PROJECT, page: 2, ref: "main", status: "failed" }),
    ).toBe(`${API}/projects/group%2Frepo/pipelines?per_page=30&page=2&ref=main&status=failed`);
  });
});

describe("gitlab job traces", () => {
  const TRACE_URL = `${API}/projects/group%2Frepo/jobs/7/trace`;

  it("gitlab_job_trace returns the whole trace text, byte for byte", async () => {
    const stub = reply("  line 1\nline 2\n");
    expect(await tools.callJson("gitlab_job_trace", { ...PROJECT, jobId: 7 })).toEqual({
      trace: "  line 1\nline 2\n",
    });
    expect(stub.only.url).toBe(TRACE_URL);
    expect(stub.only.method).toBe("GET");
    expect(stub.only.headers["private-token"]).toBe("glpat-test");
  });

  it("gitlab_job_log_tail keeps only the last maxChars characters", async () => {
    const text = `${"a".repeat(600)}${"b".repeat(1000)}`;
    const stub = reply(text);
    expect(
      await tools.callJson("gitlab_job_log_tail", { ...PROJECT, jobId: 7, maxChars: 1000 }),
    ).toEqual({ jobId: 7, truncated: true, totalChars: 1600, trace: "b".repeat(1000) });
    expect(stub.only.url).toBe(TRACE_URL);
    expect(stub.only.headers["private-token"]).toBe("glpat-test");
  });

  it("gitlab_job_log_tail returns a short trace whole", async () => {
    reply("short");
    expect(await tools.callJson("gitlab_job_log_tail", { ...PROJECT, jobId: 7 })).toEqual({
      jobId: 7,
      truncated: false,
      totalChars: 5,
      trace: "short",
    });
  });

  for (const name of ["gitlab_job_trace", "gitlab_job_log_tail"]) {
    it(`${name} quotes GitLab's status and body on failure`, async () => {
      reply({ status: 404, body: "404 Job Not Found" });
      await expect(tools.call(name, { ...PROJECT, jobId: 7 })).rejects.toThrow(
        "GitLab 404: 404 Job Not Found",
      );
    });
  }
});

describe("gitlab pipeline retry and cancel", () => {
  for (const action of ["retry", "cancel"] as const) {
    it(`gitlab_pipeline_${action} POSTs to the pipeline's ${action} endpoint`, async () => {
      const stub = reply('{"id":9,"status":"running"}');
      expect(
        await tools.callJson(`gitlab_pipeline_${action}`, { ...PROJECT, pipelineId: 9 }),
      ).toEqual({ id: 9, status: "running" });
      expect(stub.only.method).toBe("POST");
      expect(stub.only.url).toBe(`${API}/projects/group%2Frepo/pipelines/9/${action}`);
      expect(stub.only.headers["private-token"]).toBe("glpat-test");
    });

    it(`gitlab_pipeline_${action} names the action in its failure`, async () => {
      reply({ status: 403, body: "403 Forbidden" });
      await expect(
        tools.call(`gitlab_pipeline_${action}`, { ...PROJECT, pipelineId: 9 }),
      ).rejects.toThrow(`GitLab pipeline ${action} 403: 403 Forbidden`);
    });
  }
});

describe("gitlab merge request merge", () => {
  /** The method, URL and JSON body of one merge call. */
  async function merge(args: Record<string, unknown>): Promise<{ line: string; body: unknown }> {
    const stub = reply('{"state":"merged"}');
    expect(
      await tools.callJson("gitlab_mr_merge", { ...PROJECT, mergeRequestIid: 4, ...args }),
    ).toEqual({ state: "merged" });
    return {
      line: `${stub.only.method} ${stub.only.url}`,
      body: JSON.parse(stub.only.body ?? "null") as unknown,
    };
  }

  it("PUTs an empty body when no merge option is given", async () => {
    expect(await merge({})).toEqual({
      line: `PUT ${API}/projects/group%2Frepo/merge_requests/4/merge`,
      body: {},
    });
  });

  it("sends each merge option it is given, false ones included", async () => {
    expect(
      (
        await merge({
          mergeCommitMessage: "Merge !4",
          squash: false,
          shouldRemoveSourceBranch: true,
        })
      ).body,
    ).toEqual({
      merge_commit_message: "Merge !4",
      squash: false,
      should_remove_source_branch: true,
    });
  });
});

describe("gitlab issue and merge request writes (gateway mode)", () => {
  const ENC = `${API}/projects/group%2Frepo`;

  /** Call `name`; return `METHOD url` and the parsed JSON body of the one request. */
  async function write(
    name: string,
    args: Record<string, unknown>,
  ): Promise<{ line: string; body: unknown; token: string | undefined }> {
    const stub = reply('{"id":1}');
    await tools.call(name, { ...PROJECT, ...args });
    return {
      line: `${stub.only.method} ${stub.only.url}`,
      body: JSON.parse(stub.only.body ?? "null") as unknown,
      token: stub.only.headers["private-token"],
    };
  }

  it("issue_create POSTs title, description, comma-joined labels and assignee_ids", async () => {
    expect(
      await write("gitlab_issue_create", {
        title: "Crash on start",
        description: "steps",
        labels: ["bug", "p1"],
        assigneeIds: [7, 9],
      }),
    ).toEqual({
      line: `POST ${ENC}/issues`,
      body: {
        title: "Crash on start",
        description: "steps",
        labels: "bug,p1",
        assignee_ids: [7, 9],
      },
      token: "glpat-test",
    });
  });

  it("issue_create sends only the title when nothing else is given", async () => {
    expect((await write("gitlab_issue_create", { title: "t" })).body).toEqual({ title: "t" });
  });

  it("issue_note_create POSTs the body to the issue's notes", async () => {
    expect(await write("gitlab_issue_note_create", { issueIid: 3, body: "hello" })).toMatchObject({
      line: `POST ${ENC}/issues/3/notes`,
      body: { body: "hello" },
    });
  });

  it("mr_note_create POSTs the body to the merge request's notes", async () => {
    expect(await write("gitlab_mr_note_create", { mergeRequestIid: 4, body: "ok" })).toMatchObject({
      line: `POST ${ENC}/merge_requests/4/notes`,
      body: { body: "ok" },
    });
  });

  it("issue_labels_add sends add_labels, never labels, so nothing is removed", async () => {
    const out = await write("gitlab_issue_labels_add", { issueIid: 3, labels: ["a", "b c"] });
    expect(out.line).toBe(`PUT ${ENC}/issues/3`);
    expect(out.body).toEqual({ add_labels: "a,b c" });
  });

  const GQL_OK =
    '{"data":{"issueSetAssignees":{"issue":{"assignees":{"nodes":[{"username":"ada"}]}},"errors":[]}}}';

  it("issue_assignees_add APPENDs through GraphQL: one atomic add that cannot replace", async () => {
    const stub = reply(GQL_OK);
    expect(
      await tools.callJson("gitlab_issue_assignees_add", {
        ...PROJECT,
        issueIid: 3,
        assigneeUsernames: ["ada", "bo"],
      }),
    ).toEqual({ ok: true, assignees: ["ada", "bo"] });
    expect(`${stub.only.method} ${stub.only.url}`).toBe("POST https://gitlab.com/api/graphql");
    expect(stub.only.headers["private-token"]).toBe("glpat-test");
    const sent = JSON.parse(stub.only.body ?? "null") as { query: string; variables: unknown };
    expect(sent.query).toContain("issueSetAssignees");
    expect(sent.query).toContain("operationMode: APPEND");
    expect(sent.query).not.toContain("REPLACE");
    expect(sent.variables).toEqual({
      projectPath: "group/repo",
      iid: "3",
      assigneeUsernames: ["ada", "bo"],
    });
  });

  it("issue_assignees_add derives the GraphQL URL from the configured base", async () => {
    for (const [base, expected] of [
      ["https://git.example.com/api/v4", "https://git.example.com/api/graphql"],
      ["https://git.example.com/api/v4/", "https://git.example.com/api/graphql"],
      ["https://git.example.com", "https://git.example.com/api/graphql"],
      ["https://example.com/gitlab/api/v4", "https://example.com/gitlab/api/graphql"],
    ] as const) {
      process.env[BASE_ENV] = base;
      const stub = reply(GQL_OK);
      await tools.call("gitlab_issue_assignees_add", {
        ...PROJECT,
        issueIid: 3,
        assigneeUsernames: ["ada"],
      });
      expect(stub.only.url).toBe(expected);
    }
  });

  it("issue_assignees_add fails on GraphQL errors, top-level or from the mutation", async () => {
    for (const body of [
      '{"errors":[{"message":"Field not found"}]}',
      '{"data":{"issueSetAssignees":{"issue":null,"errors":["Issue not found"]}}}',
    ]) {
      reply(body);
      await expect(
        tools.call("gitlab_issue_assignees_add", {
          ...PROJECT,
          issueIid: 3,
          assigneeUsernames: ["ada"],
        }),
      ).rejects.toThrow(/GitLab GraphQL/);
    }
    reply({ status: 401, body: "unauthorized" });
    await expect(
      tools.call("gitlab_issue_assignees_add", {
        ...PROJECT,
        issueIid: 3,
        assigneeUsernames: ["ada"],
      }),
    ).rejects.toThrow("GitLab 401");
  });

  it("sends only attributes GitLab documents for each REST endpoint", async () => {
    // GitLab's REST "Update an issue" has no add_assignee_ids (only assignee_ids, which REPLACES):
    // an invented key was ignored silently once. Each list is copied from docs.gitlab.com/api.
    const DOCUMENTED: Record<string, readonly string[]> = {
      "POST issues": [
        "title",
        "description",
        "labels",
        "assignee_ids",
        "assignee_id",
        "confidential",
        "created_at",
        "due_date",
        "epic_id",
        "issue_type",
        "iid",
        "merge_request_to_resolve_discussions_of",
        "milestone_id",
        "weight",
        "discussion_to_resolve",
        "epic_iid",
      ],
      "PUT issues": [
        "title",
        "description",
        "add_labels",
        "remove_labels",
        "labels",
        "state_event",
        "assignee_ids",
        "confidential",
        "discussion_locked",
        "due_date",
        "epic_id",
        "issue_type",
        "milestone_id",
        "updated_at",
        "weight",
      ],
      "POST notes": ["body", "confidential", "internal", "created_at"],
    };
    const calls: [string, Record<string, unknown>][] = [
      ["gitlab_issue_create", { title: "t", description: "d", labels: ["a"], assigneeIds: [1] }],
      ["gitlab_issue_note_create", { issueIid: 1, body: "b" }],
      ["gitlab_mr_note_create", { mergeRequestIid: 1, body: "b" }],
      ["gitlab_issue_labels_add", { issueIid: 1, labels: ["a"] }],
      ["gitlab_issue_state_set", { issueIid: 1, stateEvent: "close" }],
    ];
    for (const [name, args] of calls) {
      const stub = reply("{}");
      await tools.call(name, { ...PROJECT, ...args });
      const key = `${stub.only.method} ${name.includes("note") ? "notes" : "issues"}`;
      const sent = Object.keys(JSON.parse(stub.only.body ?? "null") as object);
      const documented = DOCUMENTED[key];
      expect({ name, undocumented: sent.filter((k) => !documented?.includes(k)) }).toEqual({
        name,
        undocumented: [],
      });
    }
  });

  it("issue_state_set sends state_event", async () => {
    expect(
      await write("gitlab_issue_state_set", { issueIid: 3, stateEvent: "reopen" }),
    ).toMatchObject({
      line: `PUT ${ENC}/issues/3`,
      body: { state_event: "reopen" },
    });
  });

  it("refuses arguments out of range before any request", async () => {
    const stub = reply("{}");
    for (const [name, args] of [
      ["gitlab_issue_create", { title: "" }],
      ["gitlab_issue_create", { title: "t", labels: ["a,b"] }],
      ["gitlab_issue_create", { title: "t", assigneeIds: [0] }],
      ["gitlab_issue_note_create", { issueIid: 0, body: "x" }],
      ["gitlab_mr_note_create", { mergeRequestIid: 1, body: "" }],
      ["gitlab_issue_labels_add", { issueIid: 1, labels: [] }],
      ["gitlab_issue_labels_add", { issueIid: 1, labels: ["a,b"] }],
      ["gitlab_issue_assignees_add", { issueIid: 1, assigneeUsernames: [] }],
      ["gitlab_issue_assignees_add", { issueIid: 1, assigneeUsernames: [""] }],
      ["gitlab_issue_state_set", { issueIid: 1, stateEvent: "delete" }],
    ] as const) {
      await expect(tools.call(name, { ...PROJECT, ...args })).rejects.toThrow();
    }
    expect(stub.calls).toEqual([]);
  });

  it("runs end to end against a fake server named by GITLAB_API_BASE_URL", async () => {
    const seen: { method: string; path: string; body: string; token: string | null }[] = [];
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(req) {
        const url = new URL(req.url);
        seen.push({
          method: req.method,
          path: url.pathname,
          body: await req.text(),
          token: req.headers.get("private-token"),
        });
        return Response.json({ id: 42, iid: 3 });
      },
    });
    try {
      process.env[BASE_ENV] = `http://127.0.0.1:${String(server.port)}/api/v4/`;
      expect(await tools.callJson("gitlab_issue_create", { ...PROJECT, title: "e2e" })).toEqual({
        id: 42,
        iid: 3,
      });
      expect(seen).toEqual([
        {
          method: "POST",
          path: "/api/v4/projects/group%2Frepo/issues",
          body: JSON.stringify({ title: "e2e" }),
          token: "glpat-test",
        },
      ]);
    } finally {
      await server.stop(true);
    }
  });
});
