import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
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
import { registerTestflightTools } from "../src/tools.ts";

const API = "https://api.appstoreconnect.apple.com";
// grp-b has a public link (see APP_GROUPS), so the shared args say so; the public-link tests below
// use PRIVATE_ARGS and the default.
const ARGS = {
  appId: "app-1",
  buildId: "bld-1",
  betaGroupIds: ["grp-a", "grp-b"],
  allowPublicLink: true,
};
const PRIVATE_ARGS = { appId: "app-1", buildId: "bld-1", betaGroupIds: ["grp-a", "g0"] };

/** Shaped like `GET /v1/builds/{id}?include=app`: the relationship carries the app's id. */
const BUILD_OF_APP_1 = {
  data: {
    id: "bld-1",
    type: "builds",
    relationships: { app: { data: { type: "apps", id: "app-1" } } },
  },
};
const BUILD_OF_APP_2 = {
  data: {
    id: "bld-1",
    type: "builds",
    relationships: { app: { data: { type: "apps", id: "app-2" } } },
  },
};

/** Shaped like `GET /v1/builds/{id}/betaGroups`. */
const GROUPS = {
  data: [
    {
      id: "grp-x",
      type: "betaGroups",
      attributes: {
        name: "Public beta",
        isInternalGroup: false,
        publicLinkEnabled: true,
        publicLink: "https://testflight.apple.com/join/SECRET",
        hasAccessToAllBuilds: true,
      },
    },
  ],
};

let privateKeyPem: string;
let http: FetchStub | undefined;

function serve(reply: StubReply | ((req: RecordedRequest) => StubReply | undefined)): FetchStub {
  http?.restore();
  http = stubFetch(reply);
  return http;
}

function configured(fn: () => Promise<void>): Promise<void> {
  return withEnv(
    {
      TESTFLIGHT_ISSUER_ID: "issuer-1",
      TESTFLIGHT_KEY_ID: "KEY123",
      TESTFLIGHT_PRIVATE_KEY: privateKeyPem,
    },
    fn,
  );
}

/** The build's app on GET, 204 on the POST. */
/** The target groups the app has: grp-a, grp-b and g0..g19. */
const APP_GROUPS = {
  data: ["grp-a", "grp-b", ...Array.from({ length: 20 }, (_, i) => `g${String(i)}`)].map((id) => ({
    id,
    type: "betaGroups",
    attributes: { name: id, isInternalGroup: false, publicLinkEnabled: id === "grp-b" },
  })),
};

const ownedBy =
  (app: unknown) =>
  (req: RecordedRequest): StubReply => {
    if (req.method !== "GET") return { status: 204, body: "" };
    const group = /\/v1\/betaGroups\/([^/?]+)$/.exec(req.url)?.[1];
    if (group !== undefined) {
      return JSON.stringify({
        data: {
          id: group,
          type: "betaGroups",
          attributes: { publicLinkEnabled: group === "grp-b" },
        },
      });
    }
    return req.url.includes("/v1/apps/") ? JSON.stringify(APP_GROUPS) : JSON.stringify(app);
  };

beforeAll(() => {
  const { privateKey } = generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  privateKeyPem = privateKey;
});

beforeEach(() => {
  resetConnectorModeForTests();
});

afterEach(() => {
  http?.restore();
  http = undefined;
  resetConnectorModeForTests();
});

describe("testflight writes (gateway mode)", () => {
  let tools: CapturedTools;

  beforeEach(() => {
    setConnectorMode("gateway");
    tools = captureTools(registerTestflightTools);
  });

  it("checks the build's app, then POSTs the beta groups as JSON:API relationship data", async () => {
    const stub = serve(ownedBy(BUILD_OF_APP_1));
    let result: unknown;
    await configured(async () => {
      result = await tools.callJson("testflight_build_distribute", ARGS);
    });
    expect(stub.calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      `GET ${API}/v1/builds/bld-1?include=app`,
      `GET ${API}/v1/apps/app-1/betaGroups?limit=200`,
      `POST ${API}/v1/builds/bld-1/relationships/betaGroups`,
    ]);
    const post = stub.calls[2];
    expect(post?.headers["authorization"]).toMatch(/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
    expect(post?.headers["content-type"]).toBe("application/json");
    expect(JSON.parse(post?.body ?? "null")).toEqual({
      data: [
        { type: "betaGroups", id: "grp-a" },
        { type: "betaGroups", id: "grp-b" },
      ],
    });
    expect(result).toEqual({
      ok: true,
      status: "accepted",
      appId: "app-1",
      buildId: "bld-1",
      betaGroupIds: ["grp-a", "grp-b"],
    });
  });

  it("reads each target group at dispatch and sends when none has a public link", async () => {
    const stub = serve(ownedBy(BUILD_OF_APP_1));
    await configured(async () => {
      expect(await tools.callJson("testflight_build_distribute", PRIVATE_ARGS)).toMatchObject({
        ok: true,
        status: "accepted",
      });
    });
    expect(stub.calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      `GET ${API}/v1/builds/bld-1?include=app`,
      `GET ${API}/v1/apps/app-1/betaGroups?limit=200`,
      `GET ${API}/v1/betaGroups/grp-a`,
      `GET ${API}/v1/betaGroups/g0`,
      `POST ${API}/v1/builds/bld-1/relationships/betaGroups`,
    ]);
  });

  it("refuses a public-link group with testflight_public_link_forbidden and sends nothing", async () => {
    const stub = serve(ownedBy(BUILD_OF_APP_1));
    for (const args of [
      { ...ARGS, allowPublicLink: undefined },
      { ...ARGS, allowPublicLink: false },
    ]) {
      await configured(async () => {
        await expect(tools.call("testflight_build_distribute", args)).rejects.toThrow(
          /^testflight_public_link_forbidden: .*grp-b.*nothing was sent$/,
        );
      });
    }
    expect(stub.calls.filter((c) => c.method === "POST")).toEqual([]);
  });

  it("sends to a public-link group when allowPublicLink is true, without reading the groups", async () => {
    const stub = serve(ownedBy(BUILD_OF_APP_1));
    await configured(async () => {
      await tools.call("testflight_build_distribute", ARGS);
    });
    expect(stub.calls.some((c) => c.url.includes("/v1/betaGroups/"))).toBe(false);
    expect(stub.calls.filter((c) => c.method === "POST")).toHaveLength(1);
  });

  it("sends nothing when a group read fails", async () => {
    const stub = serve((req) =>
      req.url.includes("/v1/betaGroups/")
        ? { status: 500, body: "boom" }
        : ownedBy(BUILD_OF_APP_1)(req),
    );
    await configured(async () => {
      await expect(tools.call("testflight_build_distribute", PRIVATE_ARGS)).rejects.toThrow(/500/);
    });
    expect(stub.calls.filter((c) => c.method === "POST")).toEqual([]);
  });

  it("allowPublicLink must be a boolean", async () => {
    const stub = serve(ownedBy(BUILD_OF_APP_1));
    await configured(async () => {
      await expect(
        tools.call("testflight_build_distribute", { ...ARGS, allowPublicLink: "yes" }),
      ).rejects.toThrow();
    });
    expect(stub.calls).toEqual([]);
  });

  it("sends no POST for a build of another app", async () => {
    const stub = serve(ownedBy(BUILD_OF_APP_2));
    await configured(async () => {
      await expect(tools.call("testflight_build_distribute", ARGS)).rejects.toThrow(
        /does not belong to app app-1/,
      );
    });
    expect(stub.calls.map((c) => c.method)).toEqual(["GET"]);
  });

  it("sends no POST for a beta group that is not one of the app's", async () => {
    const stub = serve(ownedBy(BUILD_OF_APP_1));
    await configured(async () => {
      await expect(
        tools.call("testflight_build_distribute", {
          ...ARGS,
          betaGroupIds: ["grp-a", "grp-elsewhere"],
        }),
      ).rejects.toThrow(/grp-elsewhere do not belong to app app-1/);
    });
    expect(stub.calls.map((c) => c.method)).toEqual(["GET", "GET"]);
  });

  it("a 202 with a plain-text body is still accepted, with no second request", async () => {
    const stub = serve((req) =>
      req.method === "POST" ? { status: 202, body: "Accepted" } : ownedBy(BUILD_OF_APP_1)(req),
    );
    await configured(async () => {
      expect(await tools.callJson("testflight_build_distribute", ARGS)).toMatchObject({
        ok: true,
        status: "accepted",
      });
    });
    expect(stub.calls.filter((c) => c.method === "POST")).toHaveLength(1);
  });

  it("beta_groups_list reads the app's groups, projected, and caps the result at limit", async () => {
    const stub = serve(JSON.stringify(APP_GROUPS));
    await configured(async () => {
      const out = (await tools.callJson("testflight_beta_groups_list", {
        appId: "app-1",
        limit: 2,
      })) as { groups: unknown[] };
      expect(out.groups).toEqual([
        { id: "grp-a", name: "grp-a", isInternalGroup: false, publicLinkEnabled: false },
        { id: "grp-b", name: "grp-b", isInternalGroup: false, publicLinkEnabled: true },
      ]);
    });
    expect(stub.only.url).toBe(`${API}/v1/apps/app-1/betaGroups?limit=2`);
    await configured(async () => {
      await expect(
        tools.call("testflight_beta_groups_list", { appId: "app-1", limit: 201 }),
      ).rejects.toThrow();
      await expect(tools.call("testflight_beta_groups_list", { appId: ".." })).rejects.toThrow();
    });
  });

  it("caps a long group name at 500 characters with a marker", async () => {
    serve(
      JSON.stringify({
        data: [{ id: "g", attributes: { name: "n".repeat(900), publicLinkEnabled: true } }],
      }),
    );
    await configured(async () => {
      const out = (await tools.callJson("testflight_build_groups_get", { buildId: "bld-1" })) as {
        groups: { name: string }[];
      };
      expect(out.groups[0]?.name).toBe(`${"n".repeat(500)}...[truncated]`);
    });
  });

  it("sends no POST when the build names no app, or does not exist", async () => {
    const stub = serve(ownedBy({ data: { id: "bld-1" } }));
    await configured(async () => {
      await expect(tools.call("testflight_build_distribute", ARGS)).rejects.toThrow(
        /does not belong/,
      );
    });
    expect(stub.calls.map((c) => c.method)).toEqual(["GET"]);
    const stub2 = serve({ status: 404, body: "no such build" });
    await configured(async () => {
      await expect(tools.call("testflight_build_distribute", ARGS)).rejects.toThrow(/404/);
    });
    expect(stub2.calls.map((c) => c.method)).toEqual(["GET"]);
  });

  it("surfaces Apple's 409 and 422 refusals with their bodies", async () => {
    for (const status of [409, 422]) {
      serve((req) =>
        req.method === "GET" ? ownedBy(BUILD_OF_APP_1)(req) : { status, body: "not ready" },
      );
      await configured(async () => {
        await expect(tools.call("testflight_build_distribute", ARGS)).rejects.toThrow(
          new RegExp(`${String(status)}.*not ready`),
        );
      });
    }
  });

  it("refuses a 307 on the POST and sends no second request", async () => {
    const stub = serve((req) =>
      req.method === "GET"
        ? ownedBy(BUILD_OF_APP_1)(req)
        : { status: 307, headers: { Location: "https://evil.test/steal" } },
    );
    await configured(async () => {
      await expect(tools.call("testflight_build_distribute", ARGS)).rejects.toThrow(/redirect/i);
    });
    expect(stub.calls.map((c) => c.method)).toEqual(["GET", "GET", "POST"]);
    expect(stub.calls[2]?.redirect).toBe("manual");
  });

  it("refuses ids that could reach another path, and 0, 21 or duplicate groups, before any request", async () => {
    const stub = serve("{}");
    await configured(async () => {
      for (const bad of ["../x", "a/b", "a b", "", ".", ".."]) {
        await expect(
          tools.call("testflight_build_distribute", { ...ARGS, buildId: bad }),
        ).rejects.toThrow();
        await expect(
          tools.call("testflight_build_distribute", { ...ARGS, betaGroupIds: [bad] }),
        ).rejects.toThrow();
      }
      await expect(
        tools.call("testflight_build_distribute", { ...ARGS, betaGroupIds: [] }),
      ).rejects.toThrow();
      await expect(
        tools.call("testflight_build_distribute", {
          ...ARGS,
          betaGroupIds: Array.from({ length: 21 }, (_, i) => `g${String(i)}`),
        }),
      ).rejects.toThrow();
      await expect(
        tools.call("testflight_build_distribute", { ...ARGS, betaGroupIds: ["g1", "g1"] }),
      ).rejects.toThrow(/duplicate/);
    });
    expect(stub.calls).toEqual([]);
  });

  it("accepts exactly 20 groups", async () => {
    const stub = serve(ownedBy(BUILD_OF_APP_1));
    await configured(async () => {
      await tools.call("testflight_build_distribute", {
        ...ARGS,
        betaGroupIds: Array.from({ length: 20 }, (_, i) => `g${String(i)}`),
      });
    });
    expect(JSON.parse(stub.calls.at(-1)?.body ?? "null").data).toHaveLength(20);
  });

  it("refuses without its App Store Connect credential before any request", async () => {
    const stub = serve("{}");
    await withEnv({ TESTFLIGHT_ISSUER_ID: undefined }, async () => {
      await expect(tools.call("testflight_build_distribute", ARGS)).rejects.toThrow(
        "TESTFLIGHT_ISSUER_ID is not set",
      );
    });
    expect(stub.calls).toEqual([]);
  });

  it("projects publicLinkEnabled, and nothing like the public link itself", async () => {
    const stub = serve(JSON.stringify(GROUPS));
    await configured(async () => {
      expect(await tools.callJson("testflight_build_groups_get", { buildId: "bld-1" })).toEqual({
        groups: [
          { id: "grp-x", name: "Public beta", isInternalGroup: false, publicLinkEnabled: true },
        ],
      });
    });
    expect(stub.only.url).toBe(`${API}/v1/builds/bld-1/betaGroups?limit=200`);
  });

  it("never reports a build as distributed or completed", async () => {
    serve(ownedBy(BUILD_OF_APP_1));
    await configured(async () => {
      const text = JSON.stringify(await tools.callJson("testflight_build_distribute", ARGS));
      expect(text).not.toMatch(/deployed|done|completed|distributed/i);
    });
  });
});

describe("testflight writes (standalone mode)", () => {
  let auditDir: string;
  let auditLog: string;

  beforeEach(() => {
    setConnectorMode("standalone");
    auditDir = mkdtempSync(join(tmpdir(), "nimbus-testflight-audit-"));
    auditLog = join(auditDir, "audit.jsonl");
  });

  afterEach(() => {
    rmSync(auditDir, { recursive: true, force: true });
  });

  it("records the groups the build is already in before adding it to more", async () => {
    let tools: CapturedTools | undefined;
    await withEnv(
      {
        NIMBUS_MCP_TESTFLIGHT_WRITE_SCOPE: "app:app-1",
        NIMBUS_MCP_AUDIT_LOG: auditLog,
        NIMBUS_MCP_WRITE_BUDGET: undefined,
      },
      () => {
        tools = captureStandaloneTools(registerTestflightTools, { elicitation: true }).tools;
      },
    );
    const stub = serve((req) => {
      if (req.method === "POST") return { status: 204, body: "" };
      if (req.url.includes("/v1/apps/")) return JSON.stringify(APP_GROUPS);
      return req.url.includes("/betaGroups")
        ? JSON.stringify(GROUPS)
        : JSON.stringify(BUILD_OF_APP_1);
    });
    await configured(async () => {
      await tools?.call("testflight_build_distribute", ARGS);
    });
    expect(stub.calls.map((c) => c.method)).toEqual(["GET", "GET", "GET", "POST"]);
    const executed = readFileSync(auditLog, "utf8")
      .trim()
      .split("\n")
      .map(
        (l) =>
          (JSON.parse(l) as { entry: { outcome: string; detail: Record<string, unknown> } }).entry,
      )
      .find((e) => e.outcome === "executed");
    expect(executed?.detail["preState"]).toEqual({
      buildId: "bld-1",
      groups: [
        { id: "grp-x", name: "Public beta", isInternalGroup: false, publicLinkEnabled: true },
      ],
    });
  });
});
