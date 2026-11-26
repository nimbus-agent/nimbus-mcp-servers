import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  type CapturedTools,
  captureStandaloneTools,
  captureTools,
  type FetchStub,
  type StubReply,
  stubFetch,
  withEnv,
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

    // `page` is a tool argument, so the model chooses it. Fetched as given, a URL on another host
    // would receive the Basic credential (username and app password) with the request.
    it(`${name} refuses a next-page URL on another host and sends nothing`, async () => {
      const stub = reply("{}");
      await expect(
        tools.call(name, { repoFull: REPO, page: "https://collector.example/2.0/repositories" }),
      ).rejects.toThrow("cross-origin");
      expect(stub.calls).toEqual([]);
    });
  }

  for (const page of [
    "http://api.bitbucket.org/2.0/repositories?page=2",
    "https://api.bitbucket.org.collector.example/2.0/repositories",
    "https://api.bitbucket.org@collector.example/2.0/repositories",
    "https://api.bitbucket.org:8443/2.0/repositories",
  ]) {
    it(`refuses the look-alike next-page URL ${page}`, async () => {
      const stub = reply("{}");
      await expect(tools.call("bitbucket_repo_list", { page })).rejects.toThrow("cross-origin");
      expect(stub.calls).toEqual([]);
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

describe("bitbucket_pr_comment_create", () => {
  it("posts a general comment as content.raw", async () => {
    const stub = reply('{"id":1}');
    await tools.call("bitbucket_pr_comment_create", {
      repoFull: REPO,
      pullRequestId: 7,
      body: "hi",
    });
    const req = stub.only;
    expect(req.method).toBe("POST");
    expect(req.url).toBe(`${REPO_PATH}/pullrequests/7/comments`);
    expect(req.headers["authorization"]).toBe(BASIC);
    expect(req.headers["content-type"]).toBe("application/json");
    expect(req.body).toBe('{"content":{"raw":"hi"}}');
  });

  it("posts an inline comment with path and line", async () => {
    const stub = reply('{"id":2}');
    await tools.call("bitbucket_pr_comment_create", {
      repoFull: REPO,
      pullRequestId: 7,
      body: "nit",
      path: "src/a.ts",
      line: 12,
    });
    expect(JSON.parse(stub.only.body ?? "{}")).toEqual({
      content: { raw: "nit" },
      inline: { path: "src/a.ts", to: 12 },
    });
  });

  it("refuses line without path", async () => {
    const stub = reply("{}");
    await expect(
      tools.call("bitbucket_pr_comment_create", {
        repoFull: REPO,
        pullRequestId: 7,
        body: "hi",
        line: 3,
      }),
    ).rejects.toThrow("line requires path");
    expect(stub.calls).toEqual([]);
  });

  it("quotes the upstream status on failure", async () => {
    reply({ status: 403, body: "forbidden" });
    await expect(
      tools.call("bitbucket_pr_comment_create", {
        repoFull: REPO,
        pullRequestId: 7,
        body: "hi",
      }),
    ).rejects.toThrow("403");
  });
});

describe("bitbucket_pr_comment_create (standalone mode)", () => {
  it("refuses line without path before any consent prompt, and sends nothing", async () => {
    resetConnectorModeForTests();
    setConnectorMode("standalone");
    const stub = reply("{}");
    let capture: ReturnType<typeof captureStandaloneTools> | undefined;
    await withEnv({ NIMBUS_MCP_BITBUCKET_WRITE_SCOPE: "repo:acme/api" }, () => {
      capture = captureStandaloneTools(registerBitbucketTools, { elicitation: true });
    });
    // A refusal before consent is a result, not a thrown error.
    expect(
      await capture?.tools.callJson("bitbucket_pr_comment_create", {
        repoFull: "acme/api",
        pullRequestId: 7,
        body: "hi",
        line: 3,
      }),
    ).toEqual({ ok: false, error: "line requires path" });
    expect(capture?.prompts).toEqual([]);
    expect(stub.calls).toEqual([]);
  });
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

describe("bitbucket redirects", () => {
  const EVIL = "https://evil.example/steal";
  const REFUSED = /Bitbucket answered a POST with a redirect \(307\)/;

  it("a cross-origin 307 on the comment POST is refused and nothing goes to the other origin", async () => {
    const stub = reply({ status: 307, headers: { Location: EVIL } });
    await expect(
      tools.call("bitbucket_pr_comment_create", { repoFull: REPO, pullRequestId: 7, body: "hi" }),
    ).rejects.toThrow(REFUSED);
    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0]?.redirect).toBe("manual");
    expect(stub.calls.some((c) => new URL(c.url).host === "evil.example")).toBe(false);
  });

  it("a cross-origin 307 on the merge POST is refused and nothing goes to the other origin", async () => {
    const stub = reply({ status: 307, headers: { Location: EVIL } });
    await expect(
      tools.call("bitbucket_pr_merge", { repoFull: REPO, pullRequestId: 7 }),
    ).rejects.toThrow(REFUSED);
    expect(stub.calls).toHaveLength(1);
    expect(stub.calls.some((c) => new URL(c.url).host === "evil.example")).toBe(false);
  });

  it("a cross-origin 302 on a read is refused and the credential goes nowhere else", async () => {
    const stub = reply({ status: 302, headers: { Location: EVIL } });
    await expect(tools.call("bitbucket_repo_list", {})).rejects.toThrow(
      "Bitbucket redirected to another origin; refused",
    );
    expect(stub.calls).toHaveLength(1);
    expect(stub.calls.some((c) => new URL(c.url).host === "evil.example")).toBe(false);
  });
});
