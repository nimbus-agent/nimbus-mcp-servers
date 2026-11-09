import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type CapturedTools,
  captureStandaloneTools,
  captureTools,
  type FetchStub,
  type RecordedRequest,
  type StubReply,
  stubFetch,
  withEnv,
} from "../../../scripts/connector-tool-harness.ts";
import { resetConnectorModeForTests, setConnectorMode } from "../../../shared/connector-mode.ts";
import { registerVercelTools } from "../src/tools.ts";

const API = "https://api.vercel.com";

/** Shaped like the documented `GET /v13/deployments/{id}` reply. */
const DEPLOYMENT = {
  id: "dpl_src",
  name: "web",
  readyState: "READY",
  target: "production",
  url: "web-src.vercel.app",
};

/** Shaped like the documented `GET /v9/projects/{id}` reply (`targets.production`). */
const PROJECT = {
  id: "prj_1",
  name: "web",
  targets: {
    production: { id: "dpl_live", url: "web-live.vercel.app", readyState: "READY", createdAt: 17 },
  },
};

let http: FetchStub | undefined;

function serve(reply: StubReply | ((req: RecordedRequest) => StubReply | undefined)): FetchStub {
  http?.restore();
  http = stubFetch(reply);
  return http;
}

const withToken = (fn: () => Promise<void>, team?: string): Promise<void> =>
  withEnv({ VERCEL_TOKEN: "vc-token", VERCEL_TEAM_ID: team }, fn);

beforeEach(() => {
  resetConnectorModeForTests();
});

afterEach(() => {
  http?.restore();
  http = undefined;
  resetConnectorModeForTests();
});

describe("vercel writes (gateway mode)", () => {
  let tools: CapturedTools;

  beforeEach(() => {
    setConnectorMode("gateway");
    tools = captureTools(registerVercelTools);
  });

  /** Source deployment on GET, a new deployment on POST. */
  const redeployServer = (): FetchStub =>
    serve((req) =>
      req.method === "GET"
        ? JSON.stringify(DEPLOYMENT)
        : '{"id":"dpl_new","url":"web-new.vercel.app","readyState":"QUEUED"}',
    );

  it("redeploy reads the source for its name, then POSTs name, deploymentId and target", async () => {
    const stub = redeployServer();
    let result: unknown;
    await withToken(async () => {
      result = await tools.callJson("vercel_deployment_redeploy", {
        deploymentId: "dpl_src",
        target: "production",
      });
    });
    expect(stub.calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      `GET ${API}/v13/deployments/dpl_src`,
      `POST ${API}/v13/deployments?forceNew=1`,
    ]);
    const post = stub.calls[1];
    expect(post?.headers["authorization"]).toBe("Bearer vc-token");
    expect(post?.headers["content-type"]).toBe("application/json");
    expect(JSON.parse(post?.body ?? "null")).toEqual({
      name: "web",
      deploymentId: "dpl_src",
      target: "production",
    });
    expect(result).toEqual({
      ok: true,
      status: "accepted",
      deploymentId: "dpl_new",
      url: "web-new.vercel.app",
      readyState: "QUEUED",
    });
  });

  it("always sends target, preview included, and withLatestCommit only when given", async () => {
    const stub = redeployServer();
    await withToken(async () => {
      await tools.call("vercel_deployment_redeploy", {
        deploymentId: "dpl_src",
        target: "preview",
        withLatestCommit: true,
      });
    });
    expect(JSON.parse(stub.calls[1]?.body ?? "null")).toEqual({
      name: "web",
      deploymentId: "dpl_src",
      target: "preview",
      withLatestCommit: true,
    });
  });

  it("refuses a redeploy without a target, before any request", async () => {
    const stub = redeployServer();
    await withToken(async () => {
      await expect(
        tools.call("vercel_deployment_redeploy", { deploymentId: "dpl_src" }),
      ).rejects.toThrow();
      await expect(
        tools.call("vercel_deployment_redeploy", { deploymentId: "dpl_src", target: "staging" }),
      ).rejects.toThrow();
    });
    expect(stub.calls).toEqual([]);
  });

  it("appends the team to both redeploy requests exactly once", async () => {
    const stub = redeployServer();
    await withToken(async () => {
      await tools.call("vercel_deployment_redeploy", {
        deploymentId: "dpl_src",
        target: "production",
      });
    }, "team/1");
    expect(stub.calls.map((c) => c.url)).toEqual([
      `${API}/v13/deployments/dpl_src?teamId=team%2F1`,
      `${API}/v13/deployments?forceNew=1&teamId=team%2F1`,
    ]);
  });

  it("sends no POST for a deployment that does not exist", async () => {
    const stub = serve({ status: 404, body: "deployment not found" });
    await withToken(async () => {
      await expect(
        tools.call("vercel_deployment_redeploy", {
          deploymentId: "dpl_nope",
          target: "production",
        }),
      ).rejects.toThrow("Vercel 404: deployment not found");
    });
    expect(stub.calls.map((c) => c.method)).toEqual(["GET"]);
  });

  it("sends no POST when the source deployment has no project name", async () => {
    const stub = serve('{"id":"dpl_src","readyState":"READY"}');
    await withToken(async () => {
      await expect(
        tools.call("vercel_deployment_redeploy", { deploymentId: "dpl_src", target: "production" }),
      ).rejects.toThrow(/no project name/);
    });
    expect(stub.calls.map((c) => c.method)).toEqual(["GET"]);
  });

  it("refuses a 307 on the redeploy POST and sends no second request", async () => {
    const stub = serve((req) =>
      req.method === "GET"
        ? JSON.stringify(DEPLOYMENT)
        : { status: 307, headers: { Location: "https://evil.test/steal" } },
    );
    await withToken(async () => {
      await expect(
        tools.call("vercel_deployment_redeploy", { deploymentId: "dpl_src", target: "production" }),
      ).rejects.toThrow(/redirect/i);
    });
    expect(stub.calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      `GET ${API}/v13/deployments/dpl_src`,
      `POST ${API}/v13/deployments?forceNew=1`,
    ]);
    expect(stub.calls[1]?.redirect).toBe("manual");
  });

  it("promote POSTs the documented path with no body and no Content-Type", async () => {
    const stub = serve("");
    let result: unknown;
    await withToken(async () => {
      result = await tools.callJson("vercel_deployment_promote", {
        projectId: "prj_1",
        deploymentId: "dpl_src",
      });
    });
    const req = stub.only;
    expect(`${req.method} ${req.url}`).toBe(`POST ${API}/v10/projects/prj_1/promote/dpl_src`);
    expect(req.body).toBeUndefined();
    expect(req.headers["content-type"]).toBeUndefined();
    expect(req.headers["authorization"]).toBe("Bearer vc-token");
    expect(result).toEqual({
      ok: true,
      status: "accepted",
      projectId: "prj_1",
      deploymentId: "dpl_src",
    });
  });

  it("promote appends the team once", async () => {
    const stub = serve("{}");
    await withToken(async () => {
      await tools.call("vercel_deployment_promote", {
        projectId: "prj_1",
        deploymentId: "dpl_src",
      });
    }, "team_9");
    expect(stub.only.url).toBe(`${API}/v10/projects/prj_1/promote/dpl_src?teamId=team_9`);
  });

  it("refuses a 307 on promote and sends nothing further", async () => {
    const stub = serve({ status: 307, headers: { Location: "https://evil.test/x" } });
    await withToken(async () => {
      await expect(
        tools.call("vercel_deployment_promote", { projectId: "prj_1", deploymentId: "dpl_src" }),
      ).rejects.toThrow(/redirect/i);
    });
    expect(stub.calls).toHaveLength(1);
  });

  it("refuses ids that could reach another path, before any request", async () => {
    const stub = serve("{}");
    await withToken(async () => {
      for (const bad of ["../x", "a/b", "a b", "a?x=1", "", ".", ".."]) {
        await expect(
          tools.call("vercel_deployment_promote", { projectId: "prj_1", deploymentId: bad }),
        ).rejects.toThrow();
        await expect(
          tools.call("vercel_deployment_promote", { projectId: bad, deploymentId: "dpl_src" }),
        ).rejects.toThrow();
        await expect(
          tools.call("vercel_deployment_redeploy", { deploymentId: bad, target: "preview" }),
        ).rejects.toThrow();
        await expect(
          tools.call("vercel_project_production_get", { projectId: bad }),
        ).rejects.toThrow();
      }
    });
    expect(stub.calls).toEqual([]);
  });

  it("refuses every write without VERCEL_TOKEN before any request", async () => {
    const stub = serve("{}");
    await withEnv({ VERCEL_TOKEN: undefined }, async () => {
      await expect(
        tools.call("vercel_deployment_redeploy", { deploymentId: "dpl_src", target: "production" }),
      ).rejects.toThrow("VERCEL_TOKEN is not set");
      await expect(
        tools.call("vercel_deployment_promote", { projectId: "p", deploymentId: "d" }),
      ).rejects.toThrow("VERCEL_TOKEN is not set");
    });
    expect(stub.calls).toEqual([]);
  });

  it("never reports a deploy as deployed, done or completed", async () => {
    redeployServer();
    const texts: string[] = [];
    await withToken(async () => {
      texts.push(
        JSON.stringify(
          await tools.callJson("vercel_deployment_redeploy", {
            deploymentId: "dpl_src",
            target: "production",
          }),
        ),
      );
    });
    serve("{}");
    await withToken(async () => {
      texts.push(
        JSON.stringify(
          await tools.callJson("vercel_deployment_promote", {
            projectId: "p",
            deploymentId: "d",
          }),
        ),
      );
    });
    for (const t of texts) {
      expect(t).not.toMatch(/deployed|done|completed|"status":"(ready|success)/i);
      expect(t).toContain('"status":"accepted"');
    }
  });

  it("vercel_project_production_get projects the live deployment, or null", async () => {
    serve(JSON.stringify(PROJECT));
    await withToken(async () => {
      expect(await tools.callJson("vercel_project_production_get", { projectId: "prj_1" })).toEqual(
        {
          projectId: "prj_1",
          name: "web",
          production: {
            id: "dpl_live",
            url: "web-live.vercel.app",
            readyState: "READY",
            createdAt: 17,
          },
        },
      );
    });
    const stub = serve('{"id":"prj_2","name":"docs","targets":{}}');
    await withToken(async () => {
      expect(await tools.callJson("vercel_project_production_get", { projectId: "prj_2" })).toEqual(
        { projectId: "prj_2", name: "docs", production: null },
      );
    });
    expect(stub.only.url).toBe(`${API}/v9/projects/prj_2`);
  });
});

describe("vercel writes (standalone mode)", () => {
  let auditDir: string;
  let auditLog: string;

  beforeEach(() => {
    setConnectorMode("standalone");
    auditDir = mkdtempSync(join(tmpdir(), "nimbus-vercel-audit-"));
    auditLog = join(auditDir, "audit.jsonl");
  });

  afterEach(() => {
    rmSync(auditDir, { recursive: true, force: true });
  });

  async function standalone(scope: string): Promise<CapturedTools> {
    let tools: CapturedTools | undefined;
    await withEnv(
      {
        NIMBUS_MCP_VERCEL_WRITE_SCOPE: scope,
        NIMBUS_MCP_AUDIT_LOG: auditLog,
        NIMBUS_MCP_WRITE_BUDGET: undefined,
      },
      () => {
        tools = captureStandaloneTools(registerVercelTools, { elicitation: true }).tools;
      },
    );
    if (tools === undefined) throw new Error("registration did not run");
    return tools;
  }

  function executedPreState(): unknown {
    return readFileSync(auditLog, "utf8")
      .trim()
      .split("\n")
      .map(
        (l) =>
          (JSON.parse(l) as { entry: { outcome: string; detail: Record<string, unknown> } }).entry,
      )
      .find((e) => e.outcome === "executed")?.detail["preState"];
  }

  it("records the source deployment before a redeploy", async () => {
    const tools = await standalone("deployment:dpl_src");
    const stub = serve((req) =>
      req.method === "GET" ? JSON.stringify(DEPLOYMENT) : '{"id":"dpl_new"}',
    );
    await withToken(async () => {
      await tools.call("vercel_deployment_redeploy", {
        deploymentId: "dpl_src",
        target: "production",
      });
    });
    // pre-state GET, then the handler's own GET, then the POST.
    expect(stub.calls.map((c) => c.method)).toEqual(["GET", "GET", "POST"]);
    expect(executedPreState()).toEqual({
      id: "dpl_src",
      target: "production",
      readyState: "READY",
    });
  });

  it("records the current production deployment before a promote", async () => {
    const tools = await standalone("project:prj_1");
    const stub = serve((req) => (req.method === "GET" ? JSON.stringify(PROJECT) : ""));
    await withToken(async () => {
      await tools.call("vercel_deployment_promote", {
        projectId: "prj_1",
        deploymentId: "dpl_src",
      });
    });
    expect(stub.calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      `GET ${API}/v9/projects/prj_1`,
      `POST ${API}/v10/projects/prj_1/promote/dpl_src`,
    ]);
    expect(executedPreState()).toMatchObject({
      projectId: "prj_1",
      production: { id: "dpl_live" },
    });
  });

  it("is out of scope for another project, with no request", async () => {
    const tools = await standalone("project:prj_other");
    const stub = serve("{}");
    await withToken(async () => {
      expect(
        await tools.callJson("vercel_deployment_promote", {
          projectId: "prj_1",
          deploymentId: "dpl_src",
        }),
      ).toEqual({
        ok: false,
        error: "out of scope: project:prj_1 is not in NIMBUS_MCP_VERCEL_WRITE_SCOPE",
      });
    });
    expect(stub.calls).toEqual([]);
  });
});
