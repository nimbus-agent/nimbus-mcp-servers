import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  type CapturedTools,
  captureTools,
  type FetchStub,
  type StubReply,
  stubFetch,
  withEnv,
} from "../../../scripts/connector-tool-harness.ts";
import { resetConnectorModeForTests, setConnectorMode } from "../../../shared/connector-mode.ts";
import { registerArgocdTools } from "../src/server.ts";

const API = "https://argo.example.com/api/v1";

const APPS = [
  {
    metadata: { name: "web" },
    spec: { project: "storefront", source: { repoURL: "https://git.example.com/web.git" } },
    status: { sync: { status: "Synced" }, health: { status: "Healthy" } },
  },
  {
    metadata: { name: "billing" },
    spec: { project: "payments", source: { repoURL: "https://git.example.com/billing.git" } },
    status: { sync: { status: "OutOfSync" }, health: { status: "Degraded" } },
  },
];

let tools: CapturedTools;
let http: FetchStub | undefined;

function serve(reply: StubReply): FetchStub {
  http?.restore();
  http = stubFetch(reply);
  return http;
}

function configured(fn: () => Promise<void>): Promise<void> {
  return withEnv({ ARGOCD_URL: "https://argo.example.com/", ARGOCD_TOKEN: "argo-token" }, fn);
}

/** The application names a list call returned. */
async function listedNames(args: Record<string, unknown>): Promise<unknown[]> {
  let out: unknown;
  await configured(async () => {
    out = await tools.callJson("argocd_list", args);
  });
  return (out as { items: { metadata: { name: string } }[] }).items.map((a) => a.metadata.name);
}

// The read surface in gateway mode; the write tools are asserted in server-writes.test.ts and
// their standalone scope in scripts/connector-write-scope.test.ts.
beforeEach(() => {
  resetConnectorModeForTests();
  setConnectorMode("gateway");
  tools = captureTools(registerArgocdTools);
});

afterEach(() => {
  http?.restore();
  http = undefined;
  resetConnectorModeForTests();
});

describe("argocd read tools", () => {
  it("list reads every application, with a bearer token, from an `items` envelope", async () => {
    const stub = serve(JSON.stringify({ items: APPS }));
    expect(await listedNames({})).toEqual(["web", "billing"]);
    expect(stub.only.url).toBe(`${API}/applications`);
    expect(stub.only.headers["authorization"]).toBe("Bearer argo-token");
  });

  it("list also reads a bare array, and caps what it returns at `limit`", async () => {
    serve(JSON.stringify(APPS));
    expect(await listedNames({})).toEqual(["web", "billing"]);
    expect(await listedNames({ limit: 1 })).toEqual(["web"]);
  });

  it("list returns nothing from an answer that carries no application list", async () => {
    serve('{"metadata":{}}');
    expect(await listedNames({})).toEqual([]);
  });

  it("list passes a project filter through, and ignores an empty one", async () => {
    const stub = serve(JSON.stringify({ items: [] }));
    await listedNames({ project: "payments/eu" });
    await listedNames({ project: "" });
    expect(stub.calls.map((c) => c.url)).toEqual([
      `${API}/applications?projects=payments%2Feu`,
      `${API}/applications`,
    ]);
  });

  it("get fetches one application by its encoded name", async () => {
    const stub = serve(JSON.stringify(APPS[0]));
    await configured(async () => {
      expect(await tools.callJson("argocd_get", { name: "web/eu" })).toEqual(APPS[0]);
    });
    expect(stub.only.url).toBe(`${API}/applications/web%2Feu`);
  });

  it("search matches name, project, repo URL, sync and health status", async () => {
    serve(JSON.stringify({ items: APPS }));
    const names = async (query: string): Promise<unknown[]> => {
      let out: unknown;
      await configured(async () => {
        out = await tools.callJson("argocd_search", { query });
      });
      return (out as { matches: { metadata: { name: string } }[] }).matches.map(
        (m) => m.metadata.name,
      );
    };
    expect(await names("WEB")).toEqual(["web"]);
    expect(await names("payments")).toEqual(["billing"]);
    expect(await names("billing.git")).toEqual(["billing"]);
    expect(await names("outofsync")).toEqual(["billing"]);
    expect(await names("healthy")).toEqual(["web"]);
    expect(await names("missing")).toEqual([]);
  });

  it("refuses without ARGOCD_URL, before any request, and quotes an API failure", async () => {
    const stub = serve("[]");
    await withEnv({ ARGOCD_URL: undefined, ARGOCD_TOKEN: "t" }, async () => {
      await expect(tools.call("argocd_list", {})).rejects.toThrow("ARGOCD_URL is not set");
    });
    expect(stub.calls).toEqual([]);

    serve({ status: 404, body: '{"message":"application not found"}' });
    await configured(async () => {
      await expect(tools.call("argocd_get", { name: "gone" })).rejects.toThrow(
        'ArgoCD 404: {"message":"application not found"}',
      );
    });
  });
});
