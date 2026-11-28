import { afterEach, describe, expect, it } from "bun:test";
import { type FetchStub, stubFetch } from "../../../scripts/connector-tool-harness.ts";
import { readwiseSyncPage } from "../src/sync.ts";

let stub: FetchStub | undefined;

afterEach(() => {
  stub?.restore();
  stub = undefined;
});

describe("readwise sync never sends its token across a redirect", () => {
  it("the default transport refuses a redirect to another origin and sends nothing there", async () => {
    stub = stubFetch({ status: 302, headers: { location: "https://evil.example/steal" } });
    await expect(readwiseSyncPage(null, { token: "rw-token" })).rejects.toThrow(
      "Readwise redirected to another origin; refused",
    );
    expect(stub.calls).toHaveLength(1);
    expect(stub.only.redirect).toBe("manual");
    expect(stub.only.url).toStartWith("https://readwise.io/");
  });
});
