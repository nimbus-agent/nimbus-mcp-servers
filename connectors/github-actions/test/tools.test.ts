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
