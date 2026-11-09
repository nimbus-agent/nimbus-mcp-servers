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
import { __resetFirebaseTokenCacheForTests, registerFirebaseTools } from "../src/tools.ts";

const TOKEN_URI = "https://oauth2.example.test/token";
const API = "https://firebaseappdistribution.googleapis.com";
const APP = "1:1234567890:android:abcdef";
const DISTRIBUTE = `${API}/v1/projects/1234567890/apps/${encodeURIComponent(APP)}/releases/rel-1:distribute`;
const RELEASE = `${API}/v1/projects/1234567890/apps/${encodeURIComponent(APP)}/releases/rel-1`;
const ARGS = { appId: APP, releaseId: "rel-1" };

let serviceAccountJson: string;
let http: FetchStub | undefined;

function serve(
  api: StubReply | ((req: RecordedRequest) => StubReply | undefined),
  token: StubReply = '{"access_token":"ya29.firebase","expires_in":3600}',
): FetchStub {
  http?.restore();
  http = stubFetch((req) => {
    if (req.url === TOKEN_URI) return token;
    return typeof api === "function" ? api(req) : api;
  });
  return http;
}

function configured(fn: () => Promise<void>): Promise<void> {
  return withEnv(
    { FIREBASE_SERVICE_ACCOUNT_JSON: serviceAccountJson, FIREBASE_APP_IDS: `${APP},1:2:ios:b` },
    fn,
  );
}

/** Only the requests that went to App Distribution, not to the token endpoint. */
function apiCalls(stub: FetchStub): RecordedRequest[] {
  return stub.calls.filter((c) => c.url !== TOKEN_URI);
}

beforeAll(() => {
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  serviceAccountJson = JSON.stringify({
    type: "service_account",
    client_email: "dist@acme.iam.gserviceaccount.com",
    private_key: privateKey,
    token_uri: TOKEN_URI,
  });
});

beforeEach(() => {
  __resetFirebaseTokenCacheForTests();
  resetConnectorModeForTests();
});

afterEach(() => {
  http?.restore();
  http = undefined;
  resetConnectorModeForTests();
  __resetFirebaseTokenCacheForTests();
});

describe("firebase_app_distribution_distribute (gateway mode)", () => {
  let tools: CapturedTools;

  beforeEach(() => {
    setConnectorMode("gateway");
    tools = captureTools(registerFirebaseTools);
  });

  it("POSTs testerEmails and groupAliases to the :distribute endpoint", async () => {
    const stub = serve("{}");
    let result: unknown;
    await configured(async () => {
      result = await tools.callJson("firebase_app_distribution_distribute", {
        ...ARGS,
        testerEmails: ["ada@example.com"],
        groupAliases: ["qa-team"],
      });
    });
    const req = apiCalls(stub)[0];
    expect(apiCalls(stub)).toHaveLength(1);
    expect(`${req?.method} ${req?.url}`).toBe(`POST ${DISTRIBUTE}`);
    expect(req?.headers["authorization"]).toBe("Bearer ya29.firebase");
    expect(req?.headers["content-type"]).toBe("application/json");
    expect(JSON.parse(req?.body ?? "null")).toEqual({
      testerEmails: ["ada@example.com"],
      groupAliases: ["qa-team"],
    });
    expect(result).toEqual({
      ok: true,
      status: "accepted",
      appId: APP,
      releaseId: "rel-1",
      groupAliases: ["qa-team"],
      testerEmails: ["ada@example.com"],
    });
  });

  it("omits an empty array from the body", async () => {
    const stub = serve("{}");
    await configured(async () => {
      await tools.call("firebase_app_distribution_distribute", {
        ...ARGS,
        groupAliases: ["qa-team"],
        testerEmails: [],
      });
      await tools.call("firebase_app_distribution_distribute", {
        ...ARGS,
        testerEmails: ["ada@example.com"],
      });
    });
    const bodies = apiCalls(stub).map((c) => JSON.parse(c.body ?? "null"));
    expect(bodies).toEqual([{ groupAliases: ["qa-team"] }, { testerEmails: ["ada@example.com"] }]);
  });

  it("refuses an empty distribution, before any request", async () => {
    const stub = serve("{}");
    await configured(async () => {
      for (const args of [{}, { testerEmails: [], groupAliases: [] }]) {
        await expect(
          tools.call("firebase_app_distribution_distribute", { ...ARGS, ...args }),
        ).rejects.toThrow(/at least one/);
      }
    });
    expect(stub.calls).toEqual([]);
  });

  it("accepts 999 recipients together and refuses 1000, before any request", async () => {
    const emails = (n: number): string[] =>
      Array.from({ length: n }, (_, i) => `u${String(i)}@example.com`);
    const stub = serve("{}");
    await configured(async () => {
      await tools.call("firebase_app_distribution_distribute", {
        ...ARGS,
        testerEmails: emails(998),
        groupAliases: ["g"],
      });
    });
    expect(apiCalls(stub)).toHaveLength(1);
    const stub2 = serve("{}");
    await configured(async () => {
      await expect(
        tools.call("firebase_app_distribution_distribute", {
          ...ARGS,
          testerEmails: emails(999),
          groupAliases: ["g"],
        }),
      ).rejects.toThrow(/at most 999/);
      await expect(
        tools.call("firebase_app_distribution_distribute", { ...ARGS, testerEmails: emails(1000) }),
      ).rejects.toThrow();
    });
    expect(stub2.calls).toEqual([]);
  });

  it("refuses an email with whitespace or control characters, and a bad release id or alias", async () => {
    const stub = serve("{}");
    await configured(async () => {
      for (const bad of ["a b@example.com", "a@example.com\n", "a@ex\u0000ample.com", "x", ""]) {
        await expect(
          tools.call("firebase_app_distribution_distribute", { ...ARGS, testerEmails: [bad] }),
        ).rejects.toThrow();
      }
      for (const bad of ["../x", "a/b", "a b", "", "r:distribute"]) {
        await expect(
          tools.call("firebase_app_distribution_distribute", {
            ...ARGS,
            releaseId: bad,
            groupAliases: ["g"],
          }),
        ).rejects.toThrow();
        await expect(
          tools.call("firebase_app_distribution_distribute", { ...ARGS, groupAliases: [bad] }),
        ).rejects.toThrow();
      }
    });
    expect(stub.calls).toEqual([]);
  });

  it("sends each tester and group once, and counts the cap after de-duplication (review)", async () => {
    const stub = serve("{}");
    let result: unknown;
    await configured(async () => {
      result = await tools.callJson("firebase_app_distribution_distribute", {
        ...ARGS,
        testerEmails: ["ada@example.com", "ada@example.com"],
        groupAliases: ["qa", "qa", "beta"],
      });
    });
    const body = JSON.parse(String(apiCalls(stub)[0]?.body)) as Record<string, unknown>;
    expect(body).toEqual({ testerEmails: ["ada@example.com"], groupAliases: ["qa", "beta"] });
    expect(result).toMatchObject({
      testerEmails: ["ada@example.com"],
      groupAliases: ["qa", "beta"],
    });
    // 999 distinct + one repeat is within the cap once the repeat is dropped.
    const many = Array.from({ length: 999 }, (_, i) => `t${String(i)}@example.com`);
    const stub2 = serve("{}");
    await configured(async () => {
      await tools.callJson("firebase_app_distribution_distribute", {
        ...ARGS,
        testerEmails: [...many.slice(0, 998), many[0] as string],
        groupAliases: ["g"],
      });
    });
    expect(apiCalls(stub2)).toHaveLength(1);
  });

  it("refuses an app that is not in FIREBASE_APP_IDS, before any request", async () => {
    const stub = serve("{}");
    await configured(async () => {
      await expect(
        tools.call("firebase_app_distribution_distribute", {
          appId: "1:999:android:zzz",
          releaseId: "rel-1",
          groupAliases: ["g"],
        }),
      ).rejects.toThrow(/not in FIREBASE_APP_IDS/);
    });
    expect(stub.calls).toEqual([]);
  });

  it("refuses without a service account before any request", async () => {
    const stub = serve("{}");
    await withEnv({ FIREBASE_SERVICE_ACCOUNT_JSON: undefined, FIREBASE_APP_IDS: APP }, async () => {
      await expect(
        tools.call("firebase_app_distribution_distribute", { ...ARGS, groupAliases: ["g"] }),
      ).rejects.toThrow("FIREBASE_SERVICE_ACCOUNT_JSON is not set");
    });
    expect(stub.calls).toEqual([]);
  });

  it("refuses a 307 on the POST and sends no second request (guardedFetch, not a raw fetch)", async () => {
    const stub = serve({ status: 307, headers: { Location: "https://evil.test/steal" } });
    await configured(async () => {
      await expect(
        tools.call("firebase_app_distribution_distribute", { ...ARGS, groupAliases: ["g"] }),
      ).rejects.toThrow(/redirect/i);
    });
    expect(apiCalls(stub)).toHaveLength(1);
    expect(apiCalls(stub)[0]?.redirect).toBe("manual");
  });

  it("a read no longer follows a redirect to another origin either", async () => {
    const stub = serve({ status: 302, headers: { Location: "https://evil.test/steal" } });
    await configured(async () => {
      await expect(tools.call("firebase_get", ARGS)).rejects.toThrow(/another origin/);
    });
    expect(apiCalls(stub)).toHaveLength(1);
  });

  it("surfaces the API error (INVALID_ARGUMENT for a missing group) with its body", async () => {
    serve({ status: 400, body: '{"error":{"status":"INVALID_ARGUMENT"}}' });
    await configured(async () => {
      await expect(
        tools.call("firebase_app_distribution_distribute", { ...ARGS, groupAliases: ["nope"] }),
      ).rejects.toThrow(/400.*INVALID_ARGUMENT/);
    });
  });

  it("states the invitation-email behaviour in its description and never reports completion", async () => {
    const description = tools.get("firebase_app_distribution_distribute").description;
    expect(description).toMatch(/BECOMES a new tester/);
    expect(description).toMatch(/invitation email/);
    serve("{}");
    await configured(async () => {
      const text = JSON.stringify(
        await tools.callJson("firebase_app_distribution_distribute", {
          ...ARGS,
          groupAliases: ["g"],
        }),
      );
      expect(text).not.toMatch(/deployed|done|completed|distributed/i);
    });
  });

  it("registers with its input fields visible (no refine)", () => {
    const schema = tools.get("firebase_app_distribution_distribute").schema as { shape?: object };
    expect(Object.keys(schema.shape ?? {}).sort((a, b) => a.localeCompare(b))).toEqual([
      "appId",
      "groupAliases",
      "releaseId",
      "testerEmails",
    ]);
  });
});

describe("firebase_app_distribution_distribute (standalone mode)", () => {
  let auditDir: string;
  let auditLog: string;

  beforeEach(() => {
    setConnectorMode("standalone");
    auditDir = mkdtempSync(join(tmpdir(), "nimbus-firebase-audit-"));
    auditLog = join(auditDir, "audit.jsonl");
  });

  afterEach(() => {
    rmSync(auditDir, { recursive: true, force: true });
  });

  it("an app outside FIREBASE_APP_IDS is refused before scope, consent and the pre-state read (review)", async () => {
    let tools: CapturedTools | undefined;
    await withEnv(
      {
        // In scope, so only refuseBefore can stop it before the pre-state read.
        NIMBUS_MCP_FIREBASE_WRITE_SCOPE: "app:1:999:android:zzz",
        NIMBUS_MCP_AUDIT_LOG: auditLog,
        NIMBUS_MCP_WRITE_BUDGET: undefined,
      },
      () => {
        tools = captureStandaloneTools(registerFirebaseTools, { elicitation: true }).tools;
      },
    );
    const stub = serve("{}");
    const other = "1:999:android:zzz";
    await configured(async () => {
      await tools?.call("firebase_app_distribution_distribute", {
        appId: other,
        releaseId: "rel-1",
        groupAliases: ["g"],
      });
    });
    expect(stub.calls).toEqual([]); // no token request, no GET, no POST
    const outcomes = readFileSync(auditLog, "utf8")
      .trim()
      .split("\n")
      .map((l) => (JSON.parse(l) as { entry: { outcome: string } }).entry.outcome);
    expect(outcomes).toEqual(["refused"]);
  });

  it("records the release itself as the before-state, then distributes", async () => {
    let tools: CapturedTools | undefined;
    await withEnv(
      {
        NIMBUS_MCP_FIREBASE_WRITE_SCOPE: `app:${APP}`,
        NIMBUS_MCP_AUDIT_LOG: auditLog,
        NIMBUS_MCP_WRITE_BUDGET: undefined,
      },
      () => {
        tools = captureStandaloneTools(registerFirebaseTools, { elicitation: true }).tools;
      },
    );
    const stub = serve((req) =>
      req.method === "GET"
        ? '{"displayVersion":"2.4.0","buildVersion":"240","testState":"ACTIVE","releaseNotes":{"text":"private"}}'
        : "{}",
    );
    await configured(async () => {
      await tools?.call("firebase_app_distribution_distribute", { ...ARGS, groupAliases: ["g"] });
    });
    expect(apiCalls(stub).map((c) => `${c.method} ${c.url}`)).toEqual([
      `GET ${RELEASE}`,
      `POST ${DISTRIBUTE}`,
    ]);
    const executed = readFileSync(auditLog, "utf8")
      .trim()
      .split("\n")
      .map(
        (l) =>
          (JSON.parse(l) as { entry: { outcome: string; detail: Record<string, unknown> } }).entry,
      )
      .find((e) => e.outcome === "executed");
    expect(executed?.detail["preState"]).toEqual({
      displayVersion: "2.4.0",
      buildVersion: "240",
      testState: "ACTIVE",
    });
  });
});
