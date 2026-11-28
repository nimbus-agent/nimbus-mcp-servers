import { afterEach, describe, expect, it } from "bun:test";
import { stubFetch } from "../scripts/connector-tool-harness.ts";
import { guardedBearerJson } from "./guarded-bearer-json.ts";

describe("guardedBearerJson", () => {
  let stub: ReturnType<typeof stubFetch> | undefined;
  afterEach(() => {
    stub?.restore();
    stub = undefined;
  });

  it("sends the bearer token, lets init.headers override the defaults, and parses the body", async () => {
    stub = stubFetch('{"a":1}');
    const out = await guardedBearerJson(
      "Svc",
      "https://api.example.com/x",
      "tok",
      { headers: { "content-type": "text/plain" } },
      { "Content-Type": "application/json", "X-Default": "d" },
    );
    expect(out).toEqual({ ok: true, status: 200, json: { a: 1 }, text: '{"a":1}' });
    expect(stub.only.headers["authorization"]).toBe("Bearer tok");
    expect(stub.only.headers["content-type"]).toBe("text/plain");
    expect(stub.only.headers["x-default"]).toBe("d");
    expect(stub.only.redirect).toBe("manual");
  });

  it("reports a non-JSON body as json: null and a non-2xx as ok: false", async () => {
    stub = stubFetch({ status: 500, body: "boom" });
    expect(await guardedBearerJson("Svc", "https://api.example.com/x", "t")).toEqual({
      ok: false,
      status: 500,
      json: null,
      text: "boom",
    });
  });

  it("refuses a cross-origin redirect on a read and a 3xx on a write", async () => {
    stub = stubFetch({ status: 302, headers: { location: "https://evil.example/x" } });
    await expect(guardedBearerJson("Svc", "https://api.example.com/x", "t")).rejects.toThrow(
      "Svc redirected to another origin; refused",
    );
    await expect(
      guardedBearerJson("Svc", "https://api.example.com/x", "t", { method: "POST" }),
    ).rejects.toThrow("Svc answered a POST with a redirect (302)");
    expect(stub.calls.map((c) => c.url)).toEqual([
      "https://api.example.com/x",
      "https://api.example.com/x",
    ]);
  });
});
