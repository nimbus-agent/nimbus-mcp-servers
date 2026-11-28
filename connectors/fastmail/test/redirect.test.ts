import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { type FetchStub, stubFetch } from "../../../scripts/connector-tool-harness.ts";
import { createFetchJmapClient } from "../src/jmap-client.ts";

const SESSION_URL = "https://api.fastmail.com/jmap/session";
const API_URL = "https://api.fastmail.com/jmap/api/";
const SESSION = JSON.stringify({
  apiUrl: API_URL,
  primaryAccounts: { "urn:ietf:params:jmap:mail": "acct1" },
});

let stub: FetchStub | undefined;

beforeEach(() => {
  process.env["FASTMAIL_API_TOKEN"] = "token-123";
  delete process.env["FASTMAIL_BASE_URL"];
});

afterEach(() => {
  stub?.restore();
  stub = undefined;
  delete process.env["FASTMAIL_API_TOKEN"];
});

describe("fastmail never sends its token across a redirect", () => {
  it("the session read refuses a redirect to another origin and sends nothing there", async () => {
    stub = stubFetch({ status: 302, headers: { location: "https://evil.example/steal" } });
    await expect(createFetchJmapClient().list(5)).rejects.toThrow(
      "Fastmail redirected to another origin; refused",
    );
    expect(stub.calls.map((c) => c.url)).toEqual([SESSION_URL]);
    expect(stub.only.redirect).toBe("manual");
  });

  it("the JMAP POST refuses a 3xx instead of replaying it", async () => {
    stub = stubFetch((req) =>
      req.url === SESSION_URL ? SESSION : { status: 307, headers: { location: API_URL } },
    );
    await expect(createFetchJmapClient().list(5)).rejects.toThrow(
      "Fastmail answered a POST with a redirect (307)",
    );
    expect(stub.calls.map((c) => c.url)).toEqual([SESSION_URL, API_URL]);
  });
});
