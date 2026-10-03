import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  type CapturedTools,
  captureTools,
  type FetchStub,
  type StubReply,
  stubFetch,
} from "../../../scripts/connector-tool-harness.ts";
import { resetConnectorModeForTests, setConnectorMode } from "../../../shared/connector-mode.ts";
import { registerBitbucketTools } from "../src/tools.ts";

const API = "https://api.bitbucket.org/2.0";
const BASIC = `Basic ${btoa("ann:app-pass")}`;
const REPO = "my team/svc.api";
const REPO_PATH = `${API}/repositories/my%20team/svc.api`;

let tools: CapturedTools;
let fetchStub: FetchStub | undefined;

/** Answer every request with `r`, replacing (and restoring) any stub already installed. */
function reply(r: StubReply): FetchStub {
  fetchStub?.restore();
  fetchStub = stubFetch(r);
  return fetchStub;
}

beforeEach(() => {
  resetConnectorModeForTests();
  setConnectorMode("gateway");
  process.env["BITBUCKET_USERNAME"] = "ann";
  process.env["BITBUCKET_APP_PASSWORD"] = "app-pass";
  tools = captureTools(registerBitbucketTools);
});

afterEach(() => {
  fetchStub?.restore();
  fetchStub = undefined;
  delete process.env["BITBUCKET_USERNAME"];
  delete process.env["BITBUCKET_APP_PASSWORD"];
  resetConnectorModeForTests();
});

/** The one request a tool call made. */
async function requestOf(name: string, args: Record<string, unknown>) {
  const stub = reply('{"values":[]}');
  await tools.call(name, args);
  return stub.only;
}

describe("bitbucket reads", () => {
  const FIRST_PAGES: readonly [string, Record<string, unknown>, string][] = [
    ["bitbucket_repo_list", {}, `${API}/repositories?role=member&pagelen=30`],
    [
      "bitbucket_pr_list",
      { repoFull: REPO, state: "MERGED", pagelen: 5 },
      `${REPO_PATH}/pullrequests?pagelen=5&sort=-updated_on&q=state%3D%22MERGED%22`,
    ],
    [
      "bitbucket_pr_list",
      { repoFull: REPO },
      `${REPO_PATH}/pullrequests?pagelen=30&sort=-updated_on`,
    ],
    ["bitbucket_pipeline_list", { repoFull: REPO }, `${REPO_PATH}/pipelines/?pagelen=30`],
    ["bitbucket_issue_list", { repoFull: REPO, pagelen: 10 }, `${REPO_PATH}/issues?pagelen=10`],
    ["bitbucket_issue_list", { repoFull: REPO }, `${REPO_PATH}/issues?pagelen=30`],
    ["bitbucket_pr_get", { repoFull: REPO, pullRequestId: 42 }, `${REPO_PATH}/pullrequests/42`],
    [
      "bitbucket_pipeline_get",
      { repoFull: REPO, pipelineUuid: "{0a1b2c3d}" },
      `${REPO_PATH}/pipelines/%7B0a1b2c3d%7D`,
    ],
  ];

  for (const [name, args, url] of FIRST_PAGES) {
    it(`${name} ${JSON.stringify(args)} GETs ${url.slice(API.length)}`, async () => {
      const req = await requestOf(name, args);
      expect(req.method).toBe("GET");
      expect(req.url).toBe(url);
      expect(req.headers["authorization"]).toBe(BASIC);
      expect(req.headers["accept"]).toBe("application/json");
    });
  }

  const PAGED = [
    "bitbucket_repo_list",
    "bitbucket_pr_list",
    "bitbucket_pipeline_list",
    "bitbucket_issue_list",
  ];
  for (const name of PAGED) {
    it(`${name} follows a next-page URL as given, without building a first page`, async () => {
      const next = `${API}/repositories/x/y/whatever?page=2&pagelen=30`;
      // An unparseable repoFull proves the first page was never built.
      const req = await requestOf(name, { repoFull: "not-a-full-name", page: next });
      expect(req.url).toBe(next);
      expect(req.headers["authorization"]).toBe(BASIC);
    });
  }

  it("returns Bitbucket's JSON as the result", async () => {
    reply('{"values":[{"slug":"svc"}],"next":"n"}');
    expect(await tools.callJson("bitbucket_repo_list", {})).toEqual({
      values: [{ slug: "svc" }],
      next: "n",
    });
  });

  it("quotes Bitbucket's status and body on failure", async () => {
    reply({ status: 404, body: "Repository not found" });
    await expect(
      tools.call("bitbucket_pr_get", { repoFull: REPO, pullRequestId: 1 }),
    ).rejects.toThrow("Bitbucket 404: Repository not found");
  });

  for (const repoFull of ["noslash", "/lead", "trail/"]) {
    it(`refuses repoFull ${JSON.stringify(repoFull)} before sending anything`, async () => {
      const stub = reply("{}");
      await expect(tools.call("bitbucket_pr_get", { repoFull, pullRequestId: 1 })).rejects.toThrow(
        "repoFull must be workspace/repo_slug",
      );
      expect(stub.calls).toEqual([]);
    });
  }
});

describe("bitbucket_pr_merge", () => {
  it("POSTs the merge with only the options given", async () => {
    const stub = reply('{"state":"MERGED"}');
    expect(
      await tools.callJson("bitbucket_pr_merge", {
        repoFull: REPO,
        pullRequestId: 7,
        mergeStrategy: "squash",
      }),
    ).toEqual({ state: "MERGED" });
    const req = stub.only;
    expect(req.method).toBe("POST");
    expect(req.url).toBe(`${REPO_PATH}/pullrequests/7/merge`);
    expect(req.headers["authorization"]).toBe(BASIC);
    expect(req.headers["content-type"]).toBe("application/json");
    expect(req.body).toBe('{"type":"pullrequest","merge_strategy":"squash"}');
  });

  it("includes a merge message when one is given", async () => {
    const stub = reply("{}");
    await tools.call("bitbucket_pr_merge", { repoFull: REPO, pullRequestId: 7, message: "ship" });
    expect(stub.only.body).toBe('{"type":"pullrequest","message":"ship"}');
  });
});
