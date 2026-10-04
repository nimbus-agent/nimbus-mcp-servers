import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  type CapturedTools,
  captureTools,
  type FetchStub,
  type RecordedRequest,
  stubFetch,
} from "../../../scripts/connector-tool-harness.ts";
import { resetConnectorModeForTests, setConnectorMode } from "../../../shared/connector-mode.ts";
import { __resetJenkinsCrumbCacheForTests } from "../src/jenkins-api.ts";
import { registerJenkinsTools } from "../src/tools.ts";

const BASE = "https://ci.example.com";
const BASIC = `Basic ${btoa("bot:api-token")}`;
const CRUMB = '{"crumb":"c-123","crumbRequestField":"Jenkins-Crumb"}';

let tools: CapturedTools;
let fetchStub: FetchStub | undefined;

/** Serve the crumb issuer, and answer every POST with `post`. */
function jenkins(post: { status?: number; body?: string }): FetchStub {
  fetchStub?.restore();
  fetchStub = stubFetch((req: RecordedRequest) =>
    req.url === `${BASE}/crumbIssuer/api/json` ? CRUMB : post,
  );
  return fetchStub;
}

beforeEach(() => {
  resetConnectorModeForTests();
  setConnectorMode("gateway");
  __resetJenkinsCrumbCacheForTests();
  process.env["JENKINS_BASE_URL"] = `${BASE}/`;
  process.env["JENKINS_USERNAME"] = "bot";
  process.env["JENKINS_API_TOKEN"] = "api-token";
  tools = captureTools(registerJenkinsTools);
});

afterEach(() => {
  fetchStub?.restore();
  fetchStub = undefined;
  __resetJenkinsCrumbCacheForTests();
  delete process.env["JENKINS_BASE_URL"];
  delete process.env["JENKINS_USERNAME"];
  delete process.env["JENKINS_API_TOKEN"];
  resetConnectorModeForTests();
});

const ACTIONS = [
  {
    tool: "jenkins_build_trigger",
    action: "trigger",
    args: { jobName: "team/api build" },
    url: `${BASE}/job/team/job/api%20build/build`,
    result: { ok: true, jobName: "team/api build" },
  },
  {
    tool: "jenkins_build_abort",
    action: "abort",
    args: { jobName: "team/api build", buildNumber: 12 },
    url: `${BASE}/job/team/job/api%20build/12/stop`,
    result: { ok: true, jobName: "team/api build", buildNumber: 12 },
  },
] as const;

describe("jenkins build actions", () => {
  for (const { tool, action, args, url, result } of ACTIONS) {
    it(`${tool} fetches a crumb, then POSTs with it to ${url.slice(BASE.length)}`, async () => {
      const stub = jenkins({ status: 201, body: "" });
      expect(await tools.callJson(tool, args)).toEqual(result);
      expect(stub.calls.map((c) => `${c.method} ${c.url}`)).toEqual([
        `GET ${BASE}/crumbIssuer/api/json`,
        `POST ${url}`,
      ]);
      expect(stub.calls[1]?.headers).toEqual({ authorization: BASIC, "jenkins-crumb": "c-123" });
    });

    it(`${tool} names the ${action} in its failure`, async () => {
      jenkins({ status: 403, body: "No valid crumb" });
      await expect(tools.call(tool, args)).rejects.toThrow(`Jenkins ${action} 403: No valid crumb`);
    });

    it(`${tool} refuses before any request without credentials`, async () => {
      const stub = jenkins({ status: 201 });
      delete process.env["JENKINS_API_TOKEN"];
      await expect(tools.call(tool, args)).rejects.toThrow(
        "JENKINS_USERNAME and JENKINS_API_TOKEN must be set",
      );
      expect(stub.calls).toEqual([]);
    });
  }
});

describe("jenkins reads", () => {
  /** Answer every request with `reply`, replacing any stub already installed. */
  function serve(reply: string | { status?: number; body?: string }): FetchStub {
    fetchStub?.restore();
    fetchStub = stubFetch(reply);
    return fetchStub;
  }

  it("job_list flattens nested folders, preferring the full name and keeping urls", async () => {
    const stub = serve(
      JSON.stringify({
        jobs: [
          { name: "api", url: `${BASE}/job/api/` },
          {
            name: "team",
            fullName: "team",
            jobs: [
              { name: "web", fullName: "team/web", url: `${BASE}/job/team/job/web/` },
              // No name at all: not listed itself, but its children still are.
              { url: `${BASE}/job/team/job/x/`, jobs: [{ name: "deep", fullName: "team/x/deep" }] },
              { name: "", fullName: "" },
            ],
          },
        ],
      }),
    );
    expect(await tools.callJson("jenkins_job_list")).toEqual({
      jobs: [
        { fullName: "api", url: `${BASE}/job/api/` },
        { fullName: "team" },
        { fullName: "team/web", url: `${BASE}/job/team/job/web/` },
        { fullName: "team/x/deep" },
      ],
    });
    const url = new URL(stub.only.url);
    expect(`${url.origin}${url.pathname}`).toBe(`${BASE}/api/json`);
    expect(url.searchParams.get("tree")).toStartWith("jobs[name,fullname,url,jobs[");
    expect(stub.only.headers["authorization"]).toBe(BASIC);
  });

  it("job_list answers an empty list when the root carries no jobs array", async () => {
    serve(JSON.stringify({ _class: "hudson.model.Hudson" }));
    expect(await tools.callJson("jenkins_job_list")).toEqual({ jobs: [] });
  });

  it("job_list refuses a root that is not a JSON object", async () => {
    for (const body of ["[]", "null", "not json"]) {
      serve(body);
      await expect(tools.call("jenkins_job_list")).rejects.toThrow(
        "Jenkins: invalid jobs response",
      );
    }
  });

  it("job_get and build_get address the job by its folder path", async () => {
    const job = serve('{"name":"api build"}');
    expect(await tools.callJson("jenkins_job_get", { jobName: "team/api build" })).toEqual({
      name: "api build",
    });
    expect(job.only.url).toBe(`${BASE}/job/team/job/api%20build/api/json`);

    const build = serve('{"number":12}');
    await tools.call("jenkins_build_get", { jobName: "team/api build", buildNumber: 12 });
    expect(build.only.url).toBe(`${BASE}/job/team/job/api%20build/12/api/json`);
  });

  it("build_list asks for 20 builds by default, and for the requested limit", async () => {
    const tree = (limit: number): string =>
      encodeURIComponent(
        `builds[number,url,result,duration,timestamp,building]{0,${String(limit)}}`,
      );
    const byDefault = serve('{"builds":[]}');
    await tools.call("jenkins_build_list", { jobName: "api" });
    expect(byDefault.only.url).toBe(`${BASE}/job/api/api/json?tree=${tree(20)}`);

    const limited = serve('{"builds":[]}');
    await tools.call("jenkins_build_list", { jobName: "api", limit: 5 });
    expect(limited.only.url).toBe(`${BASE}/job/api/api/json?tree=${tree(5)}`);
  });

  it("a failed read throws Jenkins' status and body", async () => {
    serve({ status: 404, body: "Not Found" });
    await expect(tools.call("jenkins_job_get", { jobName: "nope" })).rejects.toThrow(
      "Jenkins 404: Not Found",
    );
  });

  it("build_log_tail returns the last 200 lines by default, with the total count", async () => {
    const log = Array.from({ length: 250 }, (_, i) => `line ${String(i + 1)}`).join("\r\n");
    const stub = serve(log);
    const out = (await tools.callJson("jenkins_build_log_tail", {
      jobName: "api",
      buildNumber: 7,
    })) as { jobName: string; buildNumber: number; lineCount: number; tail: string };
    expect(stub.only.url).toBe(`${BASE}/job/api/7/consoleText`);
    expect(stub.only.headers["authorization"]).toBe(BASIC);
    expect(out.jobName).toBe("api");
    expect(out.buildNumber).toBe(7);
    expect(out.lineCount).toBe(250);
    const tail = out.tail.split("\n");
    expect(tail).toHaveLength(200);
    expect(tail[0]).toBe("line 51");
    expect(tail[199]).toBe("line 250");
  });

  it("build_log_tail honours maxLines, and returns a short log whole", async () => {
    serve("a\nb\nc\nd");
    expect(
      await tools.callJson("jenkins_build_log_tail", {
        jobName: "api",
        buildNumber: 1,
        maxLines: 2,
      }),
    ).toEqual({ jobName: "api", buildNumber: 1, lineCount: 4, tail: "c\nd" });
    serve("only\nthree\nlines");
    expect(
      await tools.callJson("jenkins_build_log_tail", { jobName: "api", buildNumber: 1 }),
    ).toEqual({ jobName: "api", buildNumber: 1, lineCount: 3, tail: "only\nthree\nlines" });
  });

  it("build_log_tail throws the log's status and body on a failure", async () => {
    serve({ status: 403, body: "Forbidden" });
    await expect(
      tools.call("jenkins_build_log_tail", { jobName: "api", buildNumber: 1 }),
    ).rejects.toThrow("Jenkins log 403: Forbidden");
  });

  it("reads refuse without JENKINS_BASE_URL, before any request", async () => {
    const stub = serve("{}");
    delete process.env["JENKINS_BASE_URL"];
    await expect(tools.call("jenkins_job_list")).rejects.toThrow("JENKINS_BASE_URL is not set");
    expect(stub.calls).toEqual([]);
  });
});
