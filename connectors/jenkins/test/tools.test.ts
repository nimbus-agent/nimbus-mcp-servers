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
