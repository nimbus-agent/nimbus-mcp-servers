import { afterEach, beforeEach, describe, expect, it } from "bun:test";
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
import { NETLIFY_TOOL_NAMES, registerNetlifyTools } from "../src/tools.ts";

const API = "https://api.netlify.com";

let tools: CapturedTools;
let http: FetchStub | undefined;

function serve(reply: StubReply | ((req: RecordedRequest) => StubReply | undefined)): FetchStub {
  http?.restore();
  http = stubFetch(reply);
  return http;
}

const withToken = (fn: () => Promise<void>): Promise<void> =>
  withEnv({ NETLIFY_TOKEN: "nl-token" }, fn);

beforeEach(() => {
  setConnectorMode("gateway");
  tools = captureTools(registerNetlifyTools);
});

afterEach(() => {
  http?.restore();
  http = undefined;
  resetConnectorModeForTests();
});

describe("netlify reads", () => {
  it("registers exactly NETLIFY_TOOL_NAMES, in order", () => {
    expect(tools.registrationOrder()).toEqual([...NETLIFY_TOOL_NAMES]);
  });

  it("list, get and search keep their requests", async () => {
    const stub = serve("[]");
    await withToken(async () => {
      await tools.call("netlify_list", {});
      await tools.call("netlify_get", { siteId: "site 1" });
      await tools.call("netlify_search", { query: "x" });
    });
    expect(stub.calls.map((c) => c.url)).toEqual([
      `${API}/api/v1/sites?per_page=100&page=1`,
      `${API}/api/v1/sites/site%201`,
      `${API}/api/v1/sites?per_page=100&page=1`,
    ]);
  });

  it("deploy_list asks for the newest deploys and projects them", async () => {
    const stub = serve(
      JSON.stringify([
        {
          id: "d1",
          state: "ready",
          branch: "main",
          context: "production",
          commit_ref: "abc",
          created_at: "2026-01-01T00:00:00Z",
          published_at: "2026-01-01T00:01:00Z",
          deploy_ssl_url: "https://secret-token.example",
        },
      ]),
    );
    await withToken(async () => {
      expect(await tools.callJson("netlify_deploy_list", { siteId: "site-1", perPage: 3 })).toEqual(
        [
          {
            id: "d1",
            state: "ready",
            branch: "main",
            context: "production",
            commit_ref: "abc",
            created_at: "2026-01-01T00:00:00Z",
            published_at: "2026-01-01T00:01:00Z",
          },
        ],
      );
    });
    expect(stub.only.url).toBe(`${API}/api/v1/sites/site-1/deploys?per_page=3&page=1`);
    await withToken(async () => {
      await expect(
        tools.call("netlify_deploy_list", { siteId: "site-1", perPage: 11 }),
      ).rejects.toThrow();
    });
  });
});

describe("netlify_build_trigger (gateway mode)", () => {
  it("sends the branch and clear_cache as QUERY parameters, with no body and no Content-Type", async () => {
    const stub = serve('{"id":"bld_1","deploy_id":"dpl_1","done":false}');
    let result: unknown;
    await withToken(async () => {
      result = await tools.callJson("netlify_build_trigger", {
        siteId: "site-1",
        branch: "feature/x",
        clearCache: true,
      });
    });
    const req = stub.only;
    expect(`${req.method} ${req.url}`).toBe(
      `POST ${API}/api/v1/sites/site-1/builds?branch=feature%2Fx&clear_cache=true`,
    );
    expect(req.body).toBeUndefined();
    expect(req.headers["content-type"]).toBeUndefined();
    expect(req.headers["authorization"]).toBe("Bearer nl-token");
    expect(result).toEqual({
      ok: true,
      status: "accepted",
      siteId: "site-1",
      branch: "feature/x",
      production: false,
      buildId: "bld_1",
      deployId: "dpl_1",
    });
  });

  it("an omitted branch is a PRODUCTION build and the result says so", async () => {
    const stub = serve('{"id":"bld_2","deploy_id":"dpl_2"}');
    let result: unknown;
    await withToken(async () => {
      result = await tools.callJson("netlify_build_trigger", {
        siteId: "site-1",
        production: true,
      });
    });
    expect(stub.only.url).toBe(`${API}/api/v1/sites/site-1/builds`);
    expect(result).toMatchObject({ branch: null, production: true, buildId: "bld_2" });
  });

  it("refuses neither a branch nor production: true, and both together, before any request", async () => {
    const stub = serve("{}");
    await withToken(async () => {
      await expect(tools.call("netlify_build_trigger", { siteId: "site-1" })).rejects.toThrow(
        "name a branch, or pass production: true to publish the production site; nothing was sent",
      );
      await expect(
        tools.call("netlify_build_trigger", { siteId: "site-1", branch: "main", production: true }),
      ).rejects.toThrow(/not both/);
      await expect(
        tools.call("netlify_build_trigger", { siteId: "site-1", production: false }),
      ).rejects.toThrow();
    });
    expect(stub.calls).toEqual([]);
  });

  it("production: true sends no branch query", async () => {
    const stub = serve("{}");
    await withToken(async () => {
      await tools.call("netlify_build_trigger", { siteId: "site-1", production: true });
    });
    expect(stub.only.url).toBe(`${API}/api/v1/sites/site-1/builds`);
  });

  it("a 202 with a plain-text body is still accepted, with no second request", async () => {
    const stub = serve({ status: 202, body: "Accepted" });
    await withToken(async () => {
      expect(
        await tools.callJson("netlify_build_trigger", { siteId: "site-1", production: true }),
      ).toMatchObject({ ok: true, status: "accepted", buildId: null });
    });
    expect(stub.calls).toHaveLength(1);
  });

  it("deploy_list caps long vendor strings at 500 characters with a marker", async () => {
    serve(JSON.stringify([{ id: "d1", error_message: "e".repeat(800), branch: "b".repeat(501) }]));
    await withToken(async () => {
      const out = (await tools.callJson("netlify_deploy_list", { siteId: "site-1" })) as {
        error_message: string;
        branch: string;
      }[];
      expect(out[0]?.error_message).toBe(`${"e".repeat(500)}...[truncated]`);
      expect(out[0]?.branch).toBe(`${"b".repeat(500)}...[truncated]`);
    });
  });

  it("clearCache false sends no clear_cache", async () => {
    const stub = serve("{}");
    await withToken(async () => {
      await tools.call("netlify_build_trigger", {
        siteId: "site-1",
        branch: "main",
        clearCache: false,
      });
    });
    expect(stub.only.url).toBe(`${API}/api/v1/sites/site-1/builds?branch=main`);
  });

  it("refuses a 307 and sends no second request", async () => {
    const stub = serve({ status: 307, headers: { Location: "https://evil.test/steal" } });
    await withToken(async () => {
      await expect(
        tools.call("netlify_build_trigger", { siteId: "site-1", production: true }),
      ).rejects.toThrow(/redirect/i);
    });
    expect(stub.calls).toHaveLength(1);
    expect(stub.only.redirect).toBe("manual");
  });

  it("refuses a site id or branch that could reach another path or flag, before any request", async () => {
    const stub = serve("{}");
    await withToken(async () => {
      for (const bad of ["../x", "a/b", "a b", "", ".", ".."]) {
        await expect(
          tools.call("netlify_build_trigger", { siteId: bad, production: true }),
        ).rejects.toThrow();
      }
      for (const bad of ["../x", "-x", "a b", "a..b", "x.lock", "a&clear_cache=true"]) {
        await expect(
          tools.call("netlify_build_trigger", { siteId: "site-1", branch: bad }),
        ).rejects.toThrow();
      }
    });
    expect(stub.calls).toEqual([]);
  });

  it("refuses without NETLIFY_TOKEN before any request", async () => {
    const stub = serve("{}");
    await withEnv({ NETLIFY_TOKEN: undefined }, async () => {
      await expect(
        tools.call("netlify_build_trigger", { siteId: "site-1", production: true }),
      ).rejects.toThrow("NETLIFY_TOKEN is not set");
    });
    expect(stub.calls).toEqual([]);
  });

  it("surfaces an API refusal and never reports completion", async () => {
    serve({ status: 422, body: "bad branch" });
    await withToken(async () => {
      await expect(
        tools.call("netlify_build_trigger", { siteId: "site-1", production: true }),
      ).rejects.toThrow(/422.*bad branch/);
    });
    serve('{"id":"b","deploy_id":"d","done":true}');
    await withToken(async () => {
      const text = JSON.stringify(
        await tools.callJson("netlify_build_trigger", { siteId: "s", production: true }),
      );
      expect(text).not.toMatch(/deployed|done|completed/i);
    });
  });
});

describe("netlify_build_trigger (standalone mode)", () => {
  it("refuses a build with neither a branch nor production: true before asking or sending", async () => {
    resetConnectorModeForTests();
    setConnectorMode("standalone");
    let capture: ReturnType<typeof captureStandaloneTools> | undefined;
    await withEnv(
      { NIMBUS_MCP_NETLIFY_WRITE_SCOPE: "site:site-1", NIMBUS_MCP_AUDIT_LOG: undefined },
      () => {
        capture = captureStandaloneTools(registerNetlifyTools, { elicitation: true });
      },
    );
    const stub = serve("{}");
    await withToken(async () => {
      expect(await capture?.tools.callJson("netlify_build_trigger", { siteId: "site-1" })).toEqual({
        ok: false,
        error:
          "name a branch, or pass production: true to publish the production site; nothing was sent",
      });
    });
    expect(capture?.prompts).toEqual([]);
    expect(stub.calls).toEqual([]);
  });
});
