import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  type CapturedTools,
  captureTools,
  type FetchStub,
  stubFetch,
} from "../../../scripts/connector-tool-harness.ts";
import { resetConnectorModeForTests, setConnectorMode } from "../../../shared/connector-mode.ts";
import { registerGithubActionsTools } from "../src/tools.ts";

let tools: CapturedTools;
let fetchStub: FetchStub;

beforeEach(() => {
  resetConnectorModeForTests();
  setConnectorMode("gateway");
  process.env["GITHUB_PAT"] = "ghp_test";
  fetchStub = stubFetch("{}");
  tools = captureTools(registerGithubActionsTools);
});

afterEach(() => {
  fetchStub.restore();
  delete process.env["GITHUB_PAT"];
  resetConnectorModeForTests();
});

/** The one URL a tool call requested. */
async function urlOf(name: string, args: Record<string, unknown>): Promise<string> {
  await tools.call(name, args);
  return fetchStub.only.url;
}

const REPO = { owner: "acme co", repo: "api/v2" };

describe("github-actions list tools build GitHub's paged query, in a stable parameter order", () => {
  it("gha_workflow_list: per_page (default 30), then page when given", async () => {
    expect(await urlOf("gha_workflow_list", REPO)).toBe(
      "https://api.github.com/repos/acme%20co/api%2Fv2/actions/workflows?per_page=30",
    );
    fetchStub.calls.length = 0;
    expect(await urlOf("gha_workflow_list", { ...REPO, perPage: 10, page: 2 })).toBe(
      "https://api.github.com/repos/acme%20co/api%2Fv2/actions/workflows?per_page=10&page=2",
    );
  });

  it("gha_run_list: paging, then each filter that was given", async () => {
    expect(await urlOf("gha_run_list", REPO)).toBe(
      "https://api.github.com/repos/acme%20co/api%2Fv2/actions/runs?per_page=30",
    );
    fetchStub.calls.length = 0;
    expect(
      await urlOf("gha_run_list", {
        ...REPO,
        page: 3,
        branch: "main",
        event: "push",
        status: "completed",
      }),
    ).toBe(
      "https://api.github.com/repos/acme%20co/api%2Fv2/actions/runs?per_page=30&page=3&branch=main&event=push&status=completed",
    );
  });
});

const RUNS = "https://api.github.com/repos/acme%20co/api%2Fv2/actions";

/** Answer every request with `reply`, replacing the stub the file-level hook installed. */
function reply(body: string, status = 200): void {
  fetchStub.restore();
  fetchStub = stubFetch({ status, body });
}

describe("github-actions run reads", () => {
  it("gha_run_get and gha_run_jobs address one run of the repository", async () => {
    await tools.call("gha_run_get", { ...REPO, runId: 7 });
    await tools.call("gha_run_jobs", { ...REPO, runId: 7 });
    expect(fetchStub.calls.map((c) => c.url)).toEqual([`${RUNS}/runs/7`, `${RUNS}/runs/7/jobs`]);
    expect(fetchStub.calls[0]?.headers["authorization"]).toBe("Bearer ghp_test");
  });

  it("gha_run_log returns the whole job log when it fits", async () => {
    reply("line 1\nline 2\n");
    expect(await tools.callJson("gha_run_log", { ...REPO, jobId: 42 })).toEqual({
      jobId: 42,
      truncated: false,
      totalChars: 14,
      text: "line 1\nline 2\n",
    });
    expect(fetchStub.only.url).toBe(`${RUNS}/jobs/42/logs`);
  });

  it("gha_run_log keeps only the last `maxChars` characters of a longer log", async () => {
    const log = `${"a".repeat(1500)}${"z".repeat(1000)}`;
    reply(log);
    expect(await tools.callJson("gha_run_log", { ...REPO, jobId: 42, maxChars: 1000 })).toEqual({
      jobId: 42,
      truncated: true,
      totalChars: 2500,
      text: "z".repeat(1000),
    });
  });

  it("gha_run_log quotes GitHub's status and body when the log is unavailable", async () => {
    reply("Not Found", 404);
    await expect(tools.call("gha_run_log", { ...REPO, jobId: 42 })).rejects.toThrow(
      "GitHub Actions logs 404: Not Found",
    );
  });
});

describe("github-actions writes (gateway mode)", () => {
  it("gha_run_trigger dispatches the workflow on main with no inputs by default", async () => {
    reply("");
    expect(await tools.callJson("gha_run_trigger", { ...REPO, workflowId: "ci.yml" })).toEqual({
      ok: true,
      owner: "acme co",
      repo: "api/v2",
      workflowId: "ci.yml",
    });
    expect(`${fetchStub.only.method} ${fetchStub.only.url}`).toBe(
      `POST ${RUNS}/workflows/ci.yml/dispatches`,
    );
    expect(JSON.parse(fetchStub.only.body ?? "null")).toEqual({ ref: "main", inputs: {} });
  });

  it("gha_run_trigger sends the ref and inputs it is given", async () => {
    reply("");
    await tools.call("gha_run_trigger", {
      ...REPO,
      workflowId: "deploy.yml",
      ref: "release/1.2",
      inputs: { env: "staging" },
    });
    expect(JSON.parse(fetchStub.only.body ?? "null")).toEqual({
      ref: "release/1.2",
      inputs: { env: "staging" },
    });
  });

  it("gha_run_cancel POSTs to the run's cancel endpoint", async () => {
    reply("");
    expect(await tools.callJson("gha_run_cancel", { ...REPO, runId: 7 })).toEqual({
      ok: true,
      runId: 7,
    });
    expect(`${fetchStub.only.method} ${fetchStub.only.url}`).toBe(`POST ${RUNS}/runs/7/cancel`);
  });

  it("names the refused write and quotes GitHub's answer", async () => {
    reply("Workflow does not have 'workflow_dispatch' trigger", 422);
    await expect(tools.call("gha_run_trigger", { ...REPO, workflowId: "ci.yml" })).rejects.toThrow(
      "GitHub Actions dispatch 422: Workflow does not have 'workflow_dispatch' trigger",
    );
    reply("Cannot cancel a completed run", 409);
    await expect(tools.call("gha_run_cancel", { ...REPO, runId: 7 })).rejects.toThrow(
      "GitHub Actions cancel 409: Cannot cancel a completed run",
    );
  });
});
