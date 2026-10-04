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
import { registerVercelTools, VERCEL_TOOL_NAMES } from "../src/tools.ts";

const API = "https://api.vercel.com";

const DEPLOYMENTS = {
  deployments: [
    {
      uid: "dpl_1",
      name: "web",
      state: "READY",
      target: "production",
      url: "web-abc.vercel.app",
      meta: { githubCommitMessage: "Fix checkout" },
    },
    { uid: "dpl_2", name: "docs", state: "ERROR", target: null, url: "docs-xyz.vercel.app" },
  ],
};

let tools: CapturedTools;
let http: FetchStub | undefined;

function serve(reply: StubReply = "{}"): FetchStub {
  http?.restore();
  http = stubFetch(reply);
  return http;
}

/** Call `name` with `env`; return the one request it made. */
async function request(
  name: string,
  args: Record<string, unknown>,
  env: Record<string, string | undefined> = {},
): Promise<RecordedRequest> {
  const stub = serve();
  await withEnv({ VERCEL_TOKEN: "vc-token", VERCEL_TEAM_ID: undefined, ...env }, async () => {
    await tools.call(name, args);
  });
  return stub.only;
}

beforeEach(() => {
  tools = captureTools(registerVercelTools);
});

afterEach(() => {
  http?.restore();
  http = undefined;
});

describe("vercel tools", () => {
  it("registers exactly VERCEL_TOOL_NAMES", () => {
    expect(tools.names()).toEqual([...VERCEL_TOOL_NAMES]);
  });

  it("list asks for 100 deployments by default, and `limit` when given", async () => {
    const req = await request("vercel_list", {});
    expect(req.url).toBe(`${API}/v6/deployments?limit=100`);
    expect(req.headers["authorization"]).toBe("Bearer vc-token");
    expect((await request("vercel_list", { limit: 3 })).url).toBe(`${API}/v6/deployments?limit=3`);
  });

  it("get addresses one deployment by its encoded id or URL", async () => {
    expect((await request("vercel_get", { idOrUrl: "web-abc.vercel.app" })).url).toBe(
      `${API}/v13/deployments/web-abc.vercel.app`,
    );
    // A pasted full URL keeps its slashes and colon inside the one path segment.
    expect((await request("vercel_get", { idOrUrl: "https://web-abc.vercel.app/" })).url).toBe(
      `${API}/v13/deployments/https%3A%2F%2Fweb-abc.vercel.app%2F`,
    );
  });

  it("scopes every request to VERCEL_TEAM_ID when one is configured", async () => {
    const team = { VERCEL_TEAM_ID: " team/1 " };
    // Appended to an existing query, or as the whole query.
    expect((await request("vercel_list", {}, team)).url).toBe(
      `${API}/v6/deployments?limit=100&teamId=team%2F1`,
    );
    expect((await request("vercel_get", { idOrUrl: "dpl_1" }, team)).url).toBe(
      `${API}/v13/deployments/dpl_1?teamId=team%2F1`,
    );
    // Blank means unset.
    expect((await request("vercel_get", { idOrUrl: "dpl_1" }, { VERCEL_TEAM_ID: " " })).url).toBe(
      `${API}/v13/deployments/dpl_1`,
    );
  });

  it("search matches uid, name, state, target, host and commit message", async () => {
    const stub = serve(JSON.stringify(DEPLOYMENTS));
    const uids = async (query: string): Promise<unknown[]> => {
      let out: unknown;
      await withEnv({ VERCEL_TOKEN: "t", VERCEL_TEAM_ID: undefined }, async () => {
        out = await tools.callJson("vercel_search", { query });
      });
      return (out as { matches: { uid: string }[] }).matches.map((m) => m.uid);
    };
    expect(await uids("DPL_2")).toEqual(["dpl_2"]);
    expect(await uids("docs")).toEqual(["dpl_2"]);
    expect(await uids("ready")).toEqual(["dpl_1"]);
    expect(await uids("production")).toEqual(["dpl_1"]);
    expect(await uids("xyz.vercel")).toEqual(["dpl_2"]);
    expect(await uids("fix checkout")).toEqual(["dpl_1"]);
    expect(await uids("preview")).toEqual([]);
    expect(stub.calls[0]?.url).toBe(`${API}/v6/deployments?limit=100`);
  });

  it("search finds nothing when the answer carries no deployments array", async () => {
    serve('{"error":{"code":"forbidden"}}');
    await withEnv({ VERCEL_TOKEN: "t" }, async () => {
      expect(await tools.callJson("vercel_search", { query: "x" })).toEqual({ matches: [] });
    });
  });

  it("refuses without VERCEL_TOKEN, before any request, and quotes an API failure", async () => {
    const stub = serve();
    await withEnv({ VERCEL_TOKEN: undefined }, async () => {
      await expect(tools.call("vercel_list", {})).rejects.toThrow("VERCEL_TOKEN is not set");
    });
    expect(stub.calls).toEqual([]);

    serve({ status: 404, body: "deployment not found" });
    await withEnv({ VERCEL_TOKEN: "t" }, async () => {
      await expect(tools.call("vercel_get", { idOrUrl: "nope" })).rejects.toThrow(
        "Vercel 404: deployment not found",
      );
    });
  });
});
