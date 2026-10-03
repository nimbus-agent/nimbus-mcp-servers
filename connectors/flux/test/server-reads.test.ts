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
import { registerFluxTools } from "../src/server.ts";

const BASE = "https://k8s.example.com";
const KUSTOMIZATIONS = `${BASE}/apis/kustomize.toolkit.fluxcd.io/v1`;

const RESOURCES = [
  {
    metadata: { name: "apps", namespace: "flux-system" },
    status: { conditions: [{ type: "Ready", reason: "ReconciliationSucceeded", message: "ok" }] },
  },
  {
    metadata: { name: "infra", namespace: "platform" },
    status: { conditions: [{ type: "Ready", reason: "BuildFailed", message: "kustomize error" }] },
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
  return withEnv({ FLUX_API_URL: `${BASE}/`, FLUX_TOKEN: "sa-token" }, fn);
}

/** The resource names a list call returned. */
async function listedNames(args: Record<string, unknown>): Promise<unknown[]> {
  let out: unknown;
  await configured(async () => {
    out = await tools.callJson("flux_list", args);
  });
  return (out as { items: { metadata: { name: string } }[] }).items.map((r) => r.metadata.name);
}

// The read surface in gateway mode; the reconcile writes are asserted in server-writes.test.ts.
beforeEach(() => {
  resetConnectorModeForTests();
  setConnectorMode("gateway");
  tools = captureTools(registerFluxTools);
});

afterEach(() => {
  http?.restore();
  http = undefined;
  resetConnectorModeForTests();
});

describe("flux read tools", () => {
  it("list reads kustomizations across all namespaces by default, with a bearer token", async () => {
    const stub = serve(JSON.stringify({ items: RESOURCES }));
    expect(await listedNames({})).toEqual(["apps", "infra"]);
    expect(stub.only.url).toBe(`${KUSTOMIZATIONS}/kustomizations`);
    expect(stub.only.headers["authorization"]).toBe("Bearer sa-token");
  });

  it("list scopes to a namespace, reads the given kind, and ignores an empty namespace", async () => {
    const stub = serve(JSON.stringify({ items: [] }));
    await listedNames({ kind: "helm_release", namespace: "team a" });
    await listedNames({ namespace: "" });
    expect(stub.calls.map((c) => c.url)).toEqual([
      `${BASE}/apis/helm.toolkit.fluxcd.io/v2/namespaces/team%20a/helmreleases`,
      `${KUSTOMIZATIONS}/kustomizations`,
    ]);
  });

  it("list reads a bare array too, caps at `limit`, and finds nothing in another answer", async () => {
    serve(JSON.stringify(RESOURCES));
    expect(await listedNames({ limit: 1 })).toEqual(["apps"]);
    serve('{"kind":"Status","status":"Failure"}');
    expect(await listedNames({})).toEqual([]);
  });

  it("get addresses one resource by kind, namespace and encoded name", async () => {
    const stub = serve(JSON.stringify(RESOURCES[0]));
    await configured(async () => {
      expect(
        await tools.callJson("flux_get", {
          kind: "git_repository",
          namespace: "flux-system",
          name: "app/repo",
        }),
      ).toEqual(RESOURCES[0]);
    });
    expect(stub.only.url).toBe(
      `${BASE}/apis/source.toolkit.fluxcd.io/v1/namespaces/flux-system/gitrepositories/app%2Frepo`,
    );
  });

  it("search lists the kind in every namespace and matches name, namespace and Ready", async () => {
    const stub = serve(JSON.stringify({ items: RESOURCES }));
    const names = async (args: Record<string, unknown>): Promise<unknown[]> => {
      let out: unknown;
      await configured(async () => {
        out = await tools.callJson("flux_search", args);
      });
      return (out as { matches: { metadata: { name: string } }[] }).matches.map(
        (m) => m.metadata.name,
      );
    };
    expect(await names({ query: "INFRA" })).toEqual(["infra"]);
    expect(await names({ query: "flux-system" })).toEqual(["apps"]);
    expect(await names({ query: "buildfailed" })).toEqual(["infra"]);
    expect(await names({ query: "kustomize error" })).toEqual(["infra"]);
    expect(await names({ query: "nope" })).toEqual([]);
    await names({ query: "x", kind: "bucket" });
    expect(stub.calls.map((c) => c.url).at(-1)).toBe(
      `${BASE}/apis/source.toolkit.fluxcd.io/v1/buckets`,
    );
  });

  it("refuses without FLUX_API_URL, before any request, and quotes an API failure", async () => {
    const stub = serve("[]");
    await withEnv({ FLUX_API_URL: undefined, FLUX_TOKEN: "t" }, async () => {
      await expect(tools.call("flux_list", {})).rejects.toThrow("FLUX_API_URL is not set");
    });
    expect(stub.calls).toEqual([]);

    serve({ status: 403, body: "forbidden: cannot list kustomizations" });
    await configured(async () => {
      await expect(tools.call("flux_list", {})).rejects.toThrow(
        "Flux 403: forbidden: cannot list kustomizations",
      );
    });
  });
});
