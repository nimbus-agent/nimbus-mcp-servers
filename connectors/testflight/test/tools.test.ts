import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
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
import { registerTestflightTools, TESTFLIGHT_TOOL_NAMES } from "../src/tools.ts";

const API = "https://api.appstoreconnect.apple.com";

const BUILDS = {
  data: [
    { id: "b1", attributes: { version: "241", processingState: "VALID", minOsVersion: "17.0" } },
    {
      id: "b2",
      attributes: { version: "242", processingState: "PROCESSING", minOsVersion: "16.4" },
    },
  ],
};

let privateKeyPem: string;
let tools: CapturedTools;
let http: FetchStub | undefined;

function serve(reply: StubReply = '{"data":[]}'): FetchStub {
  http?.restore();
  http = stubFetch(reply);
  return http;
}

/** Run `fn` with a throwaway App Store Connect key, so the real ES256 signer runs. */
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

/** Call `name` configured; return the one request it made. */
async function request(name: string, args: Record<string, unknown>): Promise<RecordedRequest> {
  const stub = serve();
  await configured(async () => {
    await tools.call(name, args);
  });
  return stub.only;
}

beforeAll(() => {
  const { privateKey } = generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  privateKeyPem = privateKey;
});

beforeEach(() => {
  tools = captureTools(registerTestflightTools);
});

afterEach(() => {
  http?.restore();
  http = undefined;
});

describe("testflight tools", () => {
  it("registers exactly TESTFLIGHT_TOOL_NAMES, in order", () => {
    expect(tools.registrationOrder()).toEqual([...TESTFLIGHT_TOOL_NAMES]);
  });

  it("list with no app lists the apps, with a freshly signed ES256 bearer token", async () => {
    const req = await request("testflight_list", {});
    expect(req.url).toBe(`${API}/v1/apps`);
    const auth = req.headers["authorization"] ?? "";
    expect(auth).toStartWith("Bearer ");
    const [header] = auth.slice("Bearer ".length).split(".");
    expect(JSON.parse(Buffer.from(header ?? "", "base64url").toString("utf8"))).toMatchObject({
      alg: "ES256",
      kid: "KEY123",
    });
  });

  it("list with an app lists its newest builds, 50 by default and `limit` when given", async () => {
    expect((await request("testflight_list", { appId: "app 1" })).url).toBe(
      `${API}/v1/builds?filter[app]=app%201&sort=-uploadedDate&limit=50`,
    );
    expect((await request("testflight_list", { appId: "a", limit: 5 })).url).toBe(
      `${API}/v1/builds?filter[app]=a&sort=-uploadedDate&limit=5`,
    );
  });

  it("get returns the app without a build id, and the one build with it", async () => {
    expect((await request("testflight_get", { appId: "a/1" })).url).toBe(`${API}/v1/apps/a%2F1`);
    expect((await request("testflight_get", { appId: "a", buildId: "b/2" })).url).toBe(
      `${API}/v1/builds/b%2F2`,
    );
  });

  it("search matches a build's version, processing state, minimum OS and id", async () => {
    const stub = serve(JSON.stringify(BUILDS));
    const ids = async (query: string): Promise<unknown[]> => {
      let out: unknown;
      await configured(async () => {
        out = await tools.callJson("testflight_search", { appId: "a", query });
      });
      return (out as { matches: { id: string }[] }).matches.map((m) => m.id);
    };
    expect(await ids("242")).toEqual(["b2"]);
    expect(await ids("valid")).toEqual(["b1"]);
    expect(await ids("16.4")).toEqual(["b2"]);
    expect(await ids("b1")).toEqual(["b1"]);
    expect(await ids("android")).toEqual([]);
    expect(stub.calls[0]?.url).toBe(`${API}/v1/builds?filter[app]=a&sort=-uploadedDate&limit=200`);
  });

  it("search finds nothing when the answer carries no data array", async () => {
    serve('{"errors":[]}');
    await configured(async () => {
      expect(await tools.callJson("testflight_search", { appId: "a", query: "x" })).toEqual({
        matches: [],
      });
    });
  });

  it("refuses without its credentials, before any request, and quotes an API failure", async () => {
    const stub = serve();
    await withEnv({ TESTFLIGHT_ISSUER_ID: "i", TESTFLIGHT_KEY_ID: undefined }, async () => {
      await expect(tools.call("testflight_list", {})).rejects.toThrow(
        "TESTFLIGHT_KEY_ID is not set",
      );
    });
    expect(stub.calls).toEqual([]);

    serve({ status: 401, body: "NOT_AUTHORIZED" });
    await configured(async () => {
      await expect(tools.call("testflight_get", { appId: "a" })).rejects.toThrow(
        "App Store Connect 401: NOT_AUTHORIZED",
      );
    });
  });
});
