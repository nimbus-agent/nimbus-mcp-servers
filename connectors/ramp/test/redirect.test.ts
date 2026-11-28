import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  type CapturedTools,
  captureTools,
  type FetchStub,
  stubFetch,
  withEnv,
} from "../../../scripts/connector-tool-harness.ts";
import { __resetRampTokenForTests, registerRampTools } from "../src/tools.ts";

const API = "https://api.ramp.com";
const TOKEN_URL = `${API}/developer/v1/token`;
const TRANSACTIONS_URL = `${API}/developer/v1/transactions?page_size=100`;

let tools: CapturedTools;
let http: FetchStub | undefined;

function configured(fn: () => Promise<void>): Promise<void> {
  return withEnv({ RAMP_CLIENT_ID: "client-id", RAMP_CLIENT_SECRET: "client-secret" }, fn);
}

beforeEach(() => {
  __resetRampTokenForTests();
  tools = captureTools(registerRampTools);
});

afterEach(() => {
  http?.restore();
  http = undefined;
  __resetRampTokenForTests();
});

describe("ramp never sends its credentials across a redirect", () => {
  it("the token exchange refuses a 3xx, so the client secret is never replayed", async () => {
    http = stubFetch({ status: 307, headers: { location: "https://evil.example/steal" } });
    await configured(async () => {
      await expect(tools.call("ramp_list", {})).rejects.toThrow(
        "Ramp answered a POST with a redirect (307)",
      );
    });
    expect(http.calls.map((c) => c.url)).toEqual([TOKEN_URL]);
  });

  it("a read refuses a redirect to another origin and sends nothing there", async () => {
    http = stubFetch((req) =>
      req.url === TOKEN_URL
        ? '{"access_token":"ramp-access"}'
        : { status: 302, headers: { location: "https://evil.example/steal" } },
    );
    await configured(async () => {
      await expect(tools.call("ramp_list", {})).rejects.toThrow(
        "Ramp redirected to another origin; refused",
      );
    });
    expect(http.calls.map((c) => c.url)).toEqual([TOKEN_URL, TRANSACTIONS_URL]);
    expect(http.calls[1]?.redirect).toBe("manual");
  });
});
