import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  type CapturedTools,
  captureTools,
  type FetchStub,
  stubFetch,
  withEnv,
} from "../../../scripts/connector-tool-harness.ts";
import { __resetSupersetLoginForTests, registerSupersetTools } from "../src/tools.ts";

const BASE = "https://superset.example.com";
const LOGIN_URL = `${BASE}/api/v1/security/login`;

let tools: CapturedTools;
let http: FetchStub | undefined;

function configured(fn: () => Promise<void>): Promise<void> {
  return withEnv(
    { SUPERSET_URL: `${BASE}/`, SUPERSET_USERNAME: "admin", SUPERSET_PASSWORD: "pw" },
    fn,
  );
}

beforeEach(() => {
  __resetSupersetLoginForTests();
  tools = captureTools(registerSupersetTools);
});

afterEach(() => {
  http?.restore();
  http = undefined;
  __resetSupersetLoginForTests();
});

describe("superset never sends its credentials across a redirect", () => {
  it("the login POST refuses a 3xx, so the password is never replayed", async () => {
    http = stubFetch({ status: 307, headers: { location: "https://evil.example/steal" } });
    await configured(async () => {
      await expect(tools.call("superset_list", {})).rejects.toThrow(
        "Superset answered a POST with a redirect (307)",
      );
    });
    expect(http.calls.map((c) => c.url)).toEqual([LOGIN_URL]);
  });

  it("a read refuses a redirect to another origin and sends nothing there", async () => {
    http = stubFetch((req) =>
      req.url === LOGIN_URL
        ? '{"access_token":"jwt-1"}'
        : { status: 302, headers: { location: "https://evil.example/steal" } },
    );
    await configured(async () => {
      await expect(tools.call("superset_list", {})).rejects.toThrow(
        "Superset redirected to another origin; refused",
      );
    });
    expect(http.calls).toHaveLength(2);
    expect(http.calls[1]?.url.startsWith(`${BASE}/api/v1/dashboard/`)).toBe(true);
    expect(http.calls[1]?.redirect).toBe("manual");
  });
});
