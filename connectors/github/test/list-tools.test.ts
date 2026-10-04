import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  type CapturedTools,
  captureTools,
  type FetchStub,
  stubFetch,
} from "../../../scripts/connector-tool-harness.ts";
import { resetConnectorModeForTests, setConnectorMode } from "../../../shared/connector-mode.ts";
import { registerGithubTools } from "../src/tools.ts";

let tools: CapturedTools;
let fetchStub: FetchStub;

beforeEach(() => {
  resetConnectorModeForTests();
  setConnectorMode("gateway");
  process.env["GITHUB_PAT"] = "ghp_test";
  fetchStub = stubFetch("[]");
  tools = captureTools(registerGithubTools);
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

describe("github list tools build GitHub's paged query, in a stable parameter order", () => {
  it("github_repo_list: per_page (default 30), then sort and affiliation", async () => {
    expect(await urlOf("github_repo_list", {})).toBe(
      "https://api.github.com/user/repos?per_page=30&sort=updated&affiliation=owner%2Ccollaborator%2Corganization_member",
    );
  });

  it("github_repo_list: an explicit page follows per_page", async () => {
    expect(await urlOf("github_repo_list", { perPage: 5, page: 2 })).toBe(
      "https://api.github.com/user/repos?per_page=5&page=2&sort=updated&affiliation=owner%2Ccollaborator%2Corganization_member",
    );
  });

  it("github_pr_list: state (default open) first, newest activity first", async () => {
    expect(await urlOf("github_pr_list", REPO)).toBe(
      "https://api.github.com/repos/acme%20co/api%2Fv2/pulls?state=open&per_page=30&sort=updated&direction=desc",
    );
    fetchStub.calls.length = 0;
    expect(await urlOf("github_pr_list", { ...REPO, state: "all", perPage: 50, page: 3 })).toBe(
      "https://api.github.com/repos/acme%20co/api%2Fv2/pulls?state=all&per_page=50&page=3&sort=updated&direction=desc",
    );
  });

  it("github_issue_list: the same query as the PR list, against issues", async () => {
    expect(await urlOf("github_issue_list", { ...REPO, state: "closed", page: 4 })).toBe(
      "https://api.github.com/repos/acme%20co/api%2Fv2/issues?state=closed&per_page=30&page=4&sort=updated&direction=desc",
    );
  });

  it("github_ci_runs: paging only", async () => {
    expect(await urlOf("github_ci_runs", REPO)).toBe(
      "https://api.github.com/repos/acme%20co/api%2Fv2/actions/runs?per_page=30",
    );
    fetchStub.calls.length = 0;
    expect(await urlOf("github_ci_runs", { ...REPO, perPage: 100, page: 2 })).toBe(
      "https://api.github.com/repos/acme%20co/api%2Fv2/actions/runs?per_page=100&page=2",
    );
  });
});
