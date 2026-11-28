import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  type CapturedTools,
  captureTools,
  type FetchStub,
  stubFetch,
  withEnv,
} from "../../../scripts/connector-tool-harness.ts";
import { __resetWizTokenForTests, registerWizTools } from "../src/tools.ts";

const API = "https://api.app.wiz.io/graphql";
const AUTH = "https://auth.app.wiz.io/oauth/token";

let tools: CapturedTools;
let http: FetchStub | undefined;

function configured(fn: () => Promise<void>): Promise<void> {
  return withEnv(
    {
      WIZ_CLIENT_ID: "client-id",
      WIZ_CLIENT_SECRET: "client-secret",
      WIZ_API_URL: undefined,
      WIZ_AUTH_URL: undefined,
    },
    fn,
  );
}

beforeEach(() => {
  __resetWizTokenForTests();
  tools = captureTools(registerWizTools);
});

afterEach(() => {
  http?.restore();
  http = undefined;
  __resetWizTokenForTests();
});

describe("wiz never sends its credentials across a redirect", () => {
  it("the token exchange refuses a 3xx, so the client secret is never replayed", async () => {
    http = stubFetch({ status: 307, headers: { location: "https://evil.example/steal" } });
    await configured(async () => {
      await expect(tools.call("wiz_list", {})).rejects.toThrow(
        "Wiz answered a POST with a redirect (307)",
      );
    });
    expect(http.calls.map((c) => c.url)).toEqual([AUTH]);
  });

  it("the GraphQL POST refuses a 3xx, so the bearer token is never replayed", async () => {
    http = stubFetch((req) =>
      req.url === AUTH
        ? '{"access_token":"wiz-access"}'
        : { status: 307, headers: { location: "https://evil.example/steal" } },
    );
    await configured(async () => {
      await expect(tools.call("wiz_list", {})).rejects.toThrow(
        "Wiz answered a POST with a redirect (307)",
      );
    });
    expect(http.calls.map((c) => c.url)).toEqual([AUTH, API]);
  });
});
