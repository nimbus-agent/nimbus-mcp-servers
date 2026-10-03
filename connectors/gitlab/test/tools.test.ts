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
