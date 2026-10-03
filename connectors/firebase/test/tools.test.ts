import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  setSystemTime,
} from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import {
  type CapturedTools,
  captureTools,
  type FetchStub,
  type RecordedRequest,
  type StubReply,
  stubFetch,
  withEnv,
} from "../../../scripts/connector-tool-harness.ts";
import {
  __resetFirebaseTokenCacheForTests,
  FIREBASE_TOOL_NAMES,
  registerFirebaseTools,
} from "../src/tools.ts";

const TOKEN_URI = "https://oauth2.example.test/token";
const API = "https://firebaseappdistribution.googleapis.com";
const APP = "1:1234567890:android:abcdef";
const RELEASES = `${API}/v1/projects/1234567890/apps/${encodeURIComponent(APP)}/releases`;

const RELEASE_LIST = {
  releases: [
    {
      name: "projects/1234567890/apps/x/releases/r1",
      displayVersion: "2.4.0",
      buildVersion: "240",
      releaseNotes: { text: "Fixes the login crash" },
    },
    {
      name: "projects/1234567890/apps/x/releases/r2",
      displayVersion: "2.5.0-beta",
      buildVersion: "250",
      releaseNotes: { text: "New onboarding flow" },
    },
  ],
};

let serviceAccountJson: string;
let tools: CapturedTools;
let http: FetchStub | undefined;

/**
 * Answer the token endpoint with `token` (or the given failure) and the App Distribution API
 * with `api`. The access token is cached in the module; every test starts and ends with that
 * cache emptied, so no test sees a token another one minted.
 */
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

function at(iso: string): void {
  setSystemTime(new Date(iso));
}

beforeAll(() => {
  // A throwaway key, so the SDK really signs the RS256 assertion it sends.
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
  tools = captureTools(registerFirebaseTools);
});

afterEach(() => {
  http?.restore();
  http = undefined;
  setSystemTime();
  __resetFirebaseTokenCacheForTests();
});

afterAll(() => {
  setSystemTime();
});

/** Run `fn` with the service account and two configured app ids. */
function configured(fn: () => Promise<void>): Promise<void> {
  return withEnv(
    {
      FIREBASE_SERVICE_ACCOUNT_JSON: serviceAccountJson,
      FIREBASE_APP_IDS: ` ${APP} , 1:2:ios:b ,`,
    },
    fn,
  );
}

describe("firebase tools", () => {
  it("registers exactly FIREBASE_TOOL_NAMES", () => {
    expect(tools.names()).toEqual([...FIREBASE_TOOL_NAMES]);
  });

  it("list with no app returns the configured app ids, with no request at all", async () => {
    const stub = serve("{}");
    await configured(async () => {
      expect(await tools.callJson("firebase_list", {})).toEqual({
        appIds: [APP, "1:2:ios:b"],
      });
    });
    expect(stub.calls).toEqual([]);
  });

  it("mints a token with a JWT-bearer assertion, then reuses it until it nears expiry", async () => {
    at("2031-01-01T00:00:00Z");
    const stub = serve(JSON.stringify(RELEASE_LIST));
    await configured(async () => {
      expect(await tools.callJson("firebase_list", { appId: APP })).toEqual(RELEASE_LIST);
      await tools.call("firebase_get", { appId: APP, releaseId: "r1" });
    });
    expect(stub.calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      `POST ${TOKEN_URI}`,
      `GET ${RELEASES}?pageSize=50`,
      `GET ${RELEASES}/r1`,
    ]);
    const grant = new URLSearchParams(stub.calls[0]?.body ?? "");
    expect(grant.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:jwt-bearer");
    expect(grant.get("assertion")?.split(".")).toHaveLength(3);
    expect(stub.calls[1]?.headers["authorization"]).toBe("Bearer ya29.firebase");

    // The cache keeps a token for 30 minutes but gives it up a minute early: still reused at 28
    // minutes, replaced at 29.
    at("2031-01-01T00:28:00Z");
    await configured(async () => {
      await tools.call("firebase_list", { appId: APP, pageSize: 5 });
    });
    expect(stub.calls.slice(3).map((c) => `${c.method} ${c.url}`)).toEqual([
      `GET ${RELEASES}?pageSize=5`,
    ]);
    at("2031-01-01T00:29:00Z");
    await configured(async () => {
      await tools.call("firebase_list", { appId: APP, pageSize: 6 });
    });
    expect(stub.calls.slice(4).map((c) => `${c.method} ${c.url}`)).toEqual([
      `POST ${TOKEN_URI}`,
      `GET ${RELEASES}?pageSize=6`,
    ]);
  });

  it("refuses when the token endpoint will not mint, before calling the API", async () => {
    const stub = serve("{}", { status: 400, body: '{"error":"invalid_grant"}' });
    await configured(async () => {
      await expect(tools.call("firebase_get", { appId: APP, releaseId: "r1" })).rejects.toThrow(
        "failed to mint a Firebase access token",
      );
    });
    expect(stub.calls.map((c) => c.url)).toEqual([TOKEN_URI]);
  });

  it("surfaces an App Distribution error with its status and body", async () => {
    serve({ status: 403, body: "The caller does not have permission" });
    await configured(async () => {
      await expect(tools.call("firebase_list", { appId: APP })).rejects.toThrow(
        "Firebase App Distribution 403: The caller does not have permission",
      );
    });
  });

  it("refuses an app id it cannot derive a project number from", async () => {
    const stub = serve("{}");
    await configured(async () => {
      await expect(
        tools.call("firebase_get", { appId: "not-an-app-id", releaseId: "r" }),
      ).rejects.toThrow("cannot derive a project number from app id: not-an-app-id");
    });
    expect(stub.calls).toEqual([]);
  });

  it("search matches an app's recent releases by version and notes", async () => {
    const stub = serve(JSON.stringify(RELEASE_LIST));
    const versions = async (query: string): Promise<unknown[]> => {
      let out: unknown;
      await configured(async () => {
        out = await tools.callJson("firebase_search", { appId: APP, query });
      });
      return (out as { matches: { displayVersion: string }[] }).matches.map(
        (m) => m.displayVersion,
      );
    };
    expect(await versions("LOGIN CRASH")).toEqual(["2.4.0"]);
    expect(await versions("beta")).toEqual(["2.5.0-beta"]);
    expect(await versions("250")).toEqual(["2.5.0-beta"]);
    expect(await versions("nothing")).toEqual([]);
    expect(stub.calls.filter((c) => c.url !== TOKEN_URI)[0]?.url).toBe(`${RELEASES}?pageSize=100`);
  });

  it("search finds nothing in an answer with no releases array", async () => {
    serve("{}");
    await configured(async () => {
      expect(await tools.callJson("firebase_search", { appId: APP, query: "x" })).toEqual({
        matches: [],
      });
    });
  });
});
