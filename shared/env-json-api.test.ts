import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  createJsonGetter,
  DEFAULT_SNIPPET_MAX,
  envAuthHeaders,
  optionalBaseUrl,
  optionalEnv,
  requiredBaseUrl,
  requiredEnv,
} from "./env-json-api.ts";

const ENV = "NIMBUS_TEST_ENV_JSON_API_TOKEN";
const BASE_ENV = "NIMBUS_TEST_ENV_JSON_API_BASE";

let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  delete process.env[ENV];
  delete process.env[BASE_ENV];
});

/** Records the requests made and replies with a canned response. */
function stubFetch(reply: { status?: number; body?: string }): { calls: Request[] } {
  const calls: Request[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push(new Request(typeof input === "string" ? input : String(input), init));
    return new Response(reply.body ?? "{}", { status: reply.status ?? 200 });
  }) as typeof globalThis.fetch;
  return { calls };
}

describe("requiredEnv", () => {
  it("returns the trimmed value", () => {
    process.env[ENV] = "  abc  ";
    expect(requiredEnv(ENV)).toBe("abc");
  });

  it("throws a named error when unset", () => {
    expect(() => requiredEnv(ENV)).toThrow(`${ENV} is not set`);
  });

  it("throws when empty", () => {
    process.env[ENV] = "";
    expect(() => requiredEnv(ENV)).toThrow(`${ENV} is not set`);
  });

  it("throws when whitespace only — the case a non-trimming check lets through", () => {
    process.env[ENV] = "   ";
    expect(() => requiredEnv(ENV)).toThrow(`${ENV} is not set`);
  });
});

describe("optionalEnv", () => {
  it("returns the trimmed value when set", () => {
    process.env[ENV] = " v ";
    expect(optionalEnv(ENV, "fallback")).toBe("v");
  });

  it("falls back when unset, empty or whitespace", () => {
    expect(optionalEnv(ENV, "fallback")).toBe("fallback");
    process.env[ENV] = "";
    expect(optionalEnv(ENV, "fallback")).toBe("fallback");
    process.env[ENV] = "  ";
    expect(optionalEnv(ENV, "fallback")).toBe("fallback");
  });
});

describe("requiredBaseUrl / optionalBaseUrl", () => {
  it("strips every trailing slash so base + path cannot double up", () => {
    process.env[BASE_ENV] = "https://x.test///";
    expect(requiredBaseUrl(BASE_ENV)).toBe("https://x.test");
    expect(optionalBaseUrl(BASE_ENV, "https://fallback.test")).toBe("https://x.test");
  });

  it("strips trailing slashes from the fallback too", () => {
    expect(optionalBaseUrl(BASE_ENV, "https://fallback.test/")).toBe("https://fallback.test");
  });

  it("throws when a required base URL is unset", () => {
    expect(() => requiredBaseUrl(BASE_ENV)).toThrow(`${BASE_ENV} is not set`);
  });
});

describe("envAuthHeaders", () => {
  it("defaults to a Bearer Authorization header plus a JSON Accept", () => {
    process.env[ENV] = "tok";
    expect(envAuthHeaders({ env: ENV })()).toEqual({
      Authorization: "Bearer tok",
      Accept: "application/json",
    });
  });

  it("honours a non-Bearer scheme verbatim, including case", () => {
    process.env[ENV] = "tok";
    expect(envAuthHeaders({ env: ENV, scheme: "Token" })()["Authorization"]).toBe("Token tok");
    expect(envAuthHeaders({ env: ENV, scheme: "token" })()["Authorization"]).toBe("token tok");
  });

  it("emits the bare credential when the scheme is empty", () => {
    process.env[ENV] = "tok";
    expect(envAuthHeaders({ env: ENV, scheme: "" })()["Authorization"]).toBe("tok");
  });

  it("uses a custom header name when given", () => {
    process.env[ENV] = "k";
    expect(envAuthHeaders({ env: ENV, header: "X-Api-Key", scheme: "" })()).toEqual({
      "X-Api-Key": "k",
      Accept: "application/json",
    });
  });

  it("merges extra headers", () => {
    process.env[ENV] = "tok";
    expect(envAuthHeaders({ env: ENV, extra: { "Intercom-Version": "2.11" } })()).toEqual({
      Authorization: "Bearer tok",
      Accept: "application/json",
      "Intercom-Version": "2.11",
    });
  });

  it("reads the environment on every call, not at construction", () => {
    const headers = envAuthHeaders({ env: ENV });
    expect(() => headers()).toThrow(`${ENV} is not set`);
    process.env[ENV] = "later";
    expect(headers()["Authorization"]).toBe("Bearer later");
  });
});

describe("createJsonGetter", () => {
  it("appends the path to the base and returns the parsed body", async () => {
    const { calls } = stubFetch({ body: '{"ok":true}' });
    const get = createJsonGetter({
      base: "https://api.test",
      label: "Test",
      headers: () => ({ Accept: "application/json" }),
    });
    expect(await get("/v1/things?limit=1")).toEqual({ ok: true });
    expect(calls[0]?.url).toBe("https://api.test/v1/things?limit=1");
  });

  it("sends the headers the factory returns", async () => {
    const { calls } = stubFetch({});
    process.env[ENV] = "tok";
    await createJsonGetter({
      base: "https://api.test",
      label: "Test",
      headers: envAuthHeaders({ env: ENV }),
    })("/x");
    expect(calls[0]?.headers.get("authorization")).toBe("Bearer tok");
    expect(calls[0]?.headers.get("accept")).toBe("application/json");
  });

  it("resolves a function base per request, so env changes take effect", async () => {
    const { calls } = stubFetch({});
    const get = createJsonGetter({
      base: () => optionalBaseUrl(BASE_ENV, "https://default.test"),
      label: "Test",
      headers: () => ({}),
    });
    await get("/a");
    process.env[BASE_ENV] = "https://override.test/";
    await get("/a");
    expect(calls.map((c) => c.url)).toEqual(["https://default.test/a", "https://override.test/a"]);
  });

  it("throws `<label> <status>: <body>` on a non-2xx", async () => {
    stubFetch({ status: 404, body: "no such thing" });
    const get = createJsonGetter({
      base: "https://api.test",
      label: "Stripe",
      headers: () => ({}),
    });
    await expect(get("/x")).rejects.toThrow("Stripe 404: no such thing");
  });

  it("caps the error body at 400 characters by default", async () => {
    stubFetch({ status: 500, body: "x".repeat(1000) });
    const get = createJsonGetter({ base: "https://api.test", label: "T", headers: () => ({}) });
    const err = await get("/x").catch((e: unknown) => e as Error);
    expect(err.message).toBe(`T 500: ${"x".repeat(DEFAULT_SNIPPET_MAX)}`);
  });

  it("honours a custom snippet cap", async () => {
    stubFetch({ status: 500, body: "y".repeat(50) });
    const get = createJsonGetter({
      base: "https://api.test",
      label: "T",
      headers: () => ({}),
      snippetMax: 10,
    });
    await expect(get("/x")).rejects.toThrow(`T 500: ${"y".repeat(10)}`);
  });

  it("propagates the header factory's error without making a request", async () => {
    const { calls } = stubFetch({});
    const get = createJsonGetter({
      base: "https://api.test",
      label: "T",
      headers: envAuthHeaders({ env: ENV }),
    });
    await expect(get("/x")).rejects.toThrow(`${ENV} is not set`);
    expect(calls).toHaveLength(0);
  });

  it("surfaces a JSON parse failure on a 2xx rather than returning a partial value", async () => {
    stubFetch({ body: "<html>not json</html>" });
    const get = createJsonGetter({ base: "https://api.test", label: "T", headers: () => ({}) });
    await expect(get("/x")).rejects.toThrow();
  });
});
