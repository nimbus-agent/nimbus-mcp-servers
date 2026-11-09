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
const ARGS = { appId: "app-1", buildId: "bld-1", betaGroupIds: ["grp-a", "grp-b"] };

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
const ownedBy =
  (app: unknown) =>
  (req: RecordedRequest): StubReply =>
    req.method === "GET" ? JSON.stringify(app) : { status: 204, body: "" };

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
      `POST ${API}/v1/builds/bld-1/relationships/betaGroups`,
    ]);
    const post = stub.calls[1];
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

  it("sends no POST for a build of another app", async () => {
    const stub = serve(ownedBy(BUILD_OF_APP_2));
    await configured(async () => {
      await expect(tools.call("testflight_build_distribute", ARGS)).rejects.toThrow(
        /does not belong to app app-1/,
      );
    });
    expect(stub.calls.map((c) => c.method)).toEqual(["GET"]);
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
        req.method === "GET" ? JSON.stringify(BUILD_OF_APP_1) : { status, body: "not ready" },
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
        ? JSON.stringify(BUILD_OF_APP_1)
        : { status: 307, headers: { Location: "https://evil.test/steal" } },
    );
    await configured(async () => {
      await expect(tools.call("testflight_build_distribute", ARGS)).rejects.toThrow(/redirect/i);
    });
    expect(stub.calls.map((c) => c.method)).toEqual(["GET", "POST"]);
    expect(stub.calls[1]?.redirect).toBe("manual");
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
    expect(JSON.parse(stub.calls[1]?.body ?? "null").data).toHaveLength(20);
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
      return req.url.includes("/betaGroups")
        ? JSON.stringify(GROUPS)
        : JSON.stringify(BUILD_OF_APP_1);
    });
    await configured(async () => {
      await tools?.call("testflight_build_distribute", ARGS);
    });
    expect(stub.calls.map((c) => c.method)).toEqual(["GET", "GET", "POST"]);
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
