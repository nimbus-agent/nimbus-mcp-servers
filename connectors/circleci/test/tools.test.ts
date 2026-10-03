import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  type CapturedTools,
  captureTools,
  type FetchStub,
  type RecordedRequest,
  type StubReply,
  stubFetch,
  withEnv,
} from "../../../scripts/connector-tool-harness.ts";
import { resetConnectorModeForTests, setConnectorMode } from "../../../shared/connector-mode.ts";
import { CIRCLECI_TOOL_NAMES, registerCircleciTools } from "../src/tools.ts";

const API = "https://circleci.com/api/v2";
const UUID = "5034460f-c7c4-4c43-9457-de07e2029e7b";

let tools: CapturedTools;
let http: FetchStub | undefined;

function serve(reply: StubReply = "{}"): FetchStub {
  http?.restore();
  http = stubFetch(reply);
  return http;
}

/** Call `name` with the API token set; answer with `reply`; return the one request. */
async function request(
  name: string,
  args: Record<string, unknown>,
  reply: StubReply = "{}",
): Promise<RecordedRequest> {
  const stub = serve(reply);
  await withEnv({ CIRCLECI_API_TOKEN: "cci-token" }, async () => {
    await tools.call(name, args);
  });
  return stub.only;
}

beforeEach(() => {
  resetConnectorModeForTests();
  setConnectorMode("gateway");
  tools = captureTools(registerCircleciTools);
});

afterEach(() => {
  http?.restore();
  http = undefined;
  resetConnectorModeForTests();
});

describe("circleci reads", () => {
  it("registers exactly CIRCLECI_TOOL_NAMES, in order", () => {
    expect(tools.registrationOrder()).toEqual([...CIRCLECI_TOOL_NAMES]);
  });

  it("pipeline_list asks for the project's pipelines once under the API base", async () => {
    const req = await request("circleci_pipeline_list", { projectSlug: "gh/acme/api" });
    expect(req.url).toBe(`${API}/project/gh/acme/api/pipeline`);
    expect(req.headers["circle-token"]).toBe("cci-token");
  });

  it("pipeline_list trims and encodes each slug segment, and pages by token", async () => {
    const req = await request("circleci_pipeline_list", {
      projectSlug: " gh / acme co / api ",
      pageToken: "next page",
    });
    expect(req.url).toBe(`${API}/project/gh/acme%20co/api/pipeline?page-token=next+page`);
  });

  it("addresses a pipeline, its workflows, a workflow's jobs and a job's artifacts", async () => {
    expect((await request("circleci_pipeline_get", { pipelineId: UUID })).url).toBe(
      `${API}/pipeline/${UUID}`,
    );
    expect((await request("circleci_workflow_list", { pipelineId: UUID })).url).toBe(
      `${API}/pipeline/${UUID}/workflow`,
    );
    expect((await request("circleci_job_list", { workflowId: UUID })).url).toBe(
      `${API}/workflow/${UUID}/job`,
    );
    expect(
      (await request("circleci_job_artifacts", { projectSlug: "gh/acme/api", jobNumber: 42 })).url,
    ).toBe(`${API}/project/gh/acme/api/job/42/artifacts`);
  });

  it("quotes CircleCI's status and body when a read fails", async () => {
    serve({ status: 404, body: '{"message":"Project not found"}' });
    await withEnv({ CIRCLECI_API_TOKEN: "t" }, async () => {
      await expect(
        tools.call("circleci_pipeline_list", { projectSlug: "gh/acme/api" }),
      ).rejects.toThrow('CircleCI 404: {"message":"Project not found"}');
    });
  });

  it("refuses without CIRCLECI_API_TOKEN, before any request", async () => {
    const stub = serve();
    await withEnv({ CIRCLECI_API_TOKEN: undefined }, async () => {
      await expect(tools.call("circleci_pipeline_get", { pipelineId: UUID })).rejects.toThrow(
        "CIRCLECI_API_TOKEN is not set",
      );
      await expect(
        tools.call("circleci_job_cancel", { projectSlug: "gh/acme/api", jobNumber: 1 }),
      ).rejects.toThrow("CIRCLECI_API_TOKEN is not set");
    });
    expect(stub.calls).toEqual([]);
  });
});

describe("circleci writes", () => {
  /** The JSON body one trigger request carried. */
  async function triggerBody(args: Record<string, unknown>): Promise<unknown> {
    const req = await request("circleci_pipeline_trigger", { projectSlug: "gh/acme/api", ...args });
    expect(`${req.method} ${req.url}`).toBe(`POST ${API}/project/gh/acme/api/pipeline`);
    expect(req.headers["content-type"]).toBe("application/json");
    return JSON.parse(req.body ?? "null") as unknown;
  }

  it("pipeline_trigger builds main unless told which branch", async () => {
    expect(await triggerBody({})).toEqual({ branch: "main" });
    expect(await triggerBody({ branch: "release/2.0" })).toEqual({ branch: "release/2.0" });
  });

  it("pipeline_trigger builds a tag in place of any branch", async () => {
    expect(await triggerBody({ branch: "main", tag: "v2.0.0" })).toEqual({ tag: "v2.0.0" });
  });

  it("pipeline_trigger sends pipeline parameters only when there are some", async () => {
    expect(await triggerBody({ parameters: { deploy: "true" } })).toEqual({
      branch: "main",
      parameters: { deploy: "true" },
    });
    expect(await triggerBody({ parameters: {} })).toEqual({ branch: "main" });
  });

  it("pipeline_trigger returns CircleCI's answer, or the raw text when it is not JSON", async () => {
    serve('{"id":"p1","number":7}');
    await withEnv({ CIRCLECI_API_TOKEN: "t" }, async () => {
      expect(
        await tools.callJson("circleci_pipeline_trigger", { projectSlug: "gh/acme/api" }),
      ).toEqual({ id: "p1", number: 7 });
    });

    serve("Accepted");
    await withEnv({ CIRCLECI_API_TOKEN: "t" }, async () => {
      expect(
        await tools.callJson("circleci_pipeline_trigger", { projectSlug: "gh/acme/api" }),
      ).toEqual({ ok: true, raw: "Accepted" });
    });
  });

  it("pipeline_trigger names the trigger and quotes the body on failure", async () => {
    serve({ status: 400, body: "Branch not found" });
    await withEnv({ CIRCLECI_API_TOKEN: "t" }, async () => {
      await expect(
        tools.call("circleci_pipeline_trigger", { projectSlug: "gh/acme/api" }),
      ).rejects.toThrow("CircleCI trigger 400: Branch not found");
    });
  });

  it("job_cancel POSTs to the job's cancel endpoint and reports ok on an empty answer", async () => {
    const stub = serve({ status: 202, body: "" });
    await withEnv({ CIRCLECI_API_TOKEN: "t" }, async () => {
      expect(
        await tools.callJson("circleci_job_cancel", { projectSlug: "gh/acme/api", jobNumber: 12 }),
      ).toEqual({ ok: true });
    });
    expect(`${stub.only.method} ${stub.only.url}`).toBe(
      `POST ${API}/project/gh/acme/api/job/12/cancel`,
    );

    serve({ status: 404, body: "Job not found" });
    await withEnv({ CIRCLECI_API_TOKEN: "t" }, async () => {
      await expect(
        tools.call("circleci_job_cancel", { projectSlug: "gh/acme/api", jobNumber: 12 }),
      ).rejects.toThrow("CircleCI job cancel 404: Job not found");
    });
  });
});
