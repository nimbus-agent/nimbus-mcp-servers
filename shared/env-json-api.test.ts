import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  createJsonGetter,
  createJsonPoster,
  createJsonSender,
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

  it("resolves the base before building the headers, so a missing URL is named first", async () => {
    const { calls } = stubFetch({});
    const get = createJsonGetter({
      base: () => requiredBaseUrl(BASE_ENV),
      label: "T",
      headers: envAuthHeaders({ env: ENV }),
    });
    await expect(get("/x")).rejects.toThrow(`${BASE_ENV} is not set`);
    expect(calls).toHaveLength(0);
  });
});

describe("createJsonPoster", () => {
  it("POSTs the body as JSON, adding Content-Type to the factory's headers", async () => {
    const { calls } = stubFetch({ body: '{"queued":true}' });
    process.env[ENV] = "tok";
    const post = createJsonPoster({
      base: "https://api.test",
      label: "Test",
      headers: envAuthHeaders({ env: ENV }),
    });
    expect(await post("/v1/apps/a/sync", { prune: true })).toEqual({ queued: true });
    const call = calls[0];
    expect(call?.method).toBe("POST");
    expect(call?.url).toBe("https://api.test/v1/apps/a/sync");
    expect(call?.headers.get("authorization")).toBe("Bearer tok");
    expect(call?.headers.get("accept")).toBe("application/json");
    expect(call?.headers.get("content-type")).toBe("application/json");
    expect(await call?.text()).toBe('{"prune":true}');
  });

  it("resolves an empty 2xx body to {}", async () => {
    stubFetch({ body: "" });
    const post = createJsonPoster({ base: "https://api.test", label: "T", headers: () => ({}) });
    expect(await post("/x", {})).toEqual({});
  });

  it("names the path in the error, unlike the getter", async () => {
    stubFetch({ status: 409, body: "already syncing" });
    const post = createJsonPoster({
      base: "https://api.test",
      label: "ArgoCD",
      headers: () => ({}),
    });
    await expect(post("/applications/a/sync", {})).rejects.toThrow(
      "ArgoCD /applications/a/sync 409: already syncing",
    );
  });

  it("refuses before sending anything when the credential is missing", async () => {
    const { calls } = stubFetch({});
    const post = createJsonPoster({
      base: "https://api.test",
      label: "T",
      headers: envAuthHeaders({ env: ENV }),
    });
    await expect(post("/x", {})).rejects.toThrow(`${ENV} is not set`);
    expect(calls).toHaveLength(0);
  });

  it("uses the configured fetch instead of the global one", async () => {
    const { calls } = stubFetch({});
    const seen: string[] = [];
    const post = createJsonPoster({
      base: "https://api.test",
      label: "T",
      headers: () => ({}),
      fetch: (url) => {
        seen.push(url);
        return Promise.resolve(new Response('{"via":"seam"}'));
      },
    });
    expect(await post("/x", {})).toEqual({ via: "seam" });
    expect(seen).toEqual(["https://api.test/x"]);
    expect(calls).toHaveLength(0);
  });
});

describe("createJsonSender", () => {
  const cfg = () => ({
    base: "https://api.test",
    label: "Test",
    headers: envAuthHeaders({ env: ENV }),
  });

  it("sends the method it is given, with the factory headers and a JSON Content-Type", async () => {
    const { calls } = stubFetch({ body: '{"ok":true}' });
    process.env[ENV] = "tok";
    const send = createJsonSender(cfg());
    expect(await send("PATCH", "/flags/a", { on: true })).toEqual({ ok: true });
    const call = calls[0];
    expect(call?.method).toBe("PATCH");
    expect(call?.url).toBe("https://api.test/flags/a");
    expect(call?.headers.get("authorization")).toBe("Bearer tok");
    expect(call?.headers.get("content-type")).toBe("application/json");
    expect(await call?.text()).toBe('{"on":true}');
  });

  it("lets extraHeaders replace the default Content-Type and add others", async () => {
    const { calls } = stubFetch({});
    process.env[ENV] = "tok";
    const send = createJsonSender(cfg());
    await send(
      "PATCH",
      "/x",
      {},
      { "Content-Type": "application/json; domain-model=x", "X-A": "1" },
    );
    expect(calls[0]?.headers.get("content-type")).toBe("application/json; domain-model=x");
    expect(calls[0]?.headers.get("x-a")).toBe("1");
    expect(calls[0]?.headers.get("authorization")).toBe("Bearer tok");
  });

  it("sends no body and no Content-Type when the body is undefined", async () => {
    const { calls } = stubFetch({ body: '{"id":"b1"}' });
    process.env[ENV] = "tok";
    const send = createJsonSender(cfg());
    expect(await send("POST", "/builds?branch=main", undefined)).toEqual({ id: "b1" });
    const call = calls[0];
    expect(call?.method).toBe("POST");
    expect(call?.headers.get("content-type")).toBeNull();
    expect(call?.body).toBeNull();
    expect(call?.headers.get("authorization")).toBe("Bearer tok");
  });

  it("resolves a 2xx whose body is not JSON to {} instead of throwing", async () => {
    const { calls } = stubFetch({ status: 202, body: "Accepted" });
    process.env[ENV] = "tok";
    expect(await createJsonSender(cfg())("POST", "/x", undefined)).toEqual({});
    expect(calls).toHaveLength(1);
  });

  it("still throws for a non-2xx whatever its body", async () => {
    stubFetch({ status: 500, body: "Accepted" });
    process.env[ENV] = "tok";
    await expect(createJsonSender(cfg())("POST", "/x", undefined)).rejects.toThrow("500");
  });

  it("refuses a 307 on a POST with no second request", async () => {
    const { calls } = stubFetch({ status: 307 });
    process.env[ENV] = "tok";
    await expect(createJsonSender(cfg())("POST", "/x", undefined)).rejects.toThrow(/redirect/);
    expect(calls).toHaveLength(1);
  });

  it("names label, method and path in the error", async () => {
    stubFetch({ status: 405, body: "needs approval" });
    process.env[ENV] = "tok";
    const send = createJsonSender(cfg());
    await expect(send("PATCH", "/flags/a", {})).rejects.toThrow(
      "Test PATCH /flags/a 405: needs approval",
    );
  });

  it("resolves an empty 2xx body to {}", async () => {
    stubFetch({ body: "" });
    process.env[ENV] = "tok";
    expect(await createJsonSender(cfg())("PUT", "/x", {})).toEqual({});
  });

  it("refuses before sending anything when the credential is missing", async () => {
    const { calls } = stubFetch({});
    await expect(createJsonSender(cfg())("PATCH", "/x", {})).rejects.toThrow(`${ENV} is not set`);
    expect(calls).toEqual([]);
  });

  it("asks fetch not to follow redirects and refuses a 3xx without a second request", async () => {
    const seen: (RequestRedirect | undefined)[] = [];
    const calls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(String(input));
      seen.push(init?.redirect);
      return new Response("", { status: 302, headers: { Location: "https://evil.test/steal" } });
    }) as typeof globalThis.fetch;
    process.env[ENV] = "tok";
    await expect(createJsonSender(cfg())("PATCH", "/x", {})).rejects.toThrow(/redirect/i);
    expect(seen).toEqual(["manual"]);
    expect(calls).toEqual(["https://api.test/x"]);
  });
});

describe("createJsonPoster redirects", () => {
  it("refuses a 3xx and never follows it", async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(`${String(input)} ${String(init?.redirect)}`);
      return new Response("", { status: 307, headers: { Location: "https://evil.test/" } });
    }) as typeof globalThis.fetch;
    process.env[ENV] = "tok";
    const post = createJsonPoster({
      base: "https://api.test",
      label: "T",
      headers: envAuthHeaders({ env: ENV }),
    });
    await expect(post("/x", {})).rejects.toThrow(/redirect/i);
    expect(calls).toEqual(["https://api.test/x manual"]);
  });
});

describe("createJsonGetter redirects", () => {
  /** Answers each URL from `routes`; records every request's URL, header and redirect mode. */
  function route(routes: Record<string, { status: number; location?: string; body?: string }>): {
    seen: { url: string; auth: string | null; redirect: string | undefined }[];
  } {
    const seen: { url: string; auth: string | null; redirect: string | undefined }[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      seen.push({
        url,
        auth: new Headers(init?.headers).get("authorization"),
        redirect: init?.redirect,
      });
      const hit = routes[url];
      if (hit === undefined) return new Response("{}", { status: 404 });
      return new Response(hit.body ?? "", {
        status: hit.status,
        headers: hit.location === undefined ? {} : { Location: hit.location },
      });
    }) as typeof globalThis.fetch;
    return { seen };
  }

  const getter = () =>
    createJsonGetter({
      base: "https://api.test",
      label: "T",
      headers: envAuthHeaders({ env: ENV, scheme: "" }),
    });

  it("follows a same-origin https redirect, asking for manual on every hop", async () => {
    const { seen } = route({
      "https://api.test/a": { status: 301, location: "/a/" },
      "https://api.test/a/": { status: 200, body: '{"ok":true}' },
    });
    process.env[ENV] = "tok";
    expect(await getter()("/a")).toEqual({ ok: true });
    expect(seen.map((s) => s.url)).toEqual(["https://api.test/a", "https://api.test/a/"]);
    expect(seen.map((s) => s.redirect)).toEqual(["manual", "manual"]);
    expect(seen.map((s) => s.auth)).toEqual(["tok", "tok"]);
  });

  it("refuses a cross-origin redirect and sends nothing to the other origin", async () => {
    const { seen } = route({
      "https://api.test/a": { status: 302, location: "https://evil.test/steal" },
    });
    process.env[ENV] = "tok";
    await expect(getter()("/a")).rejects.toThrow(/another origin/);
    expect(seen.map((s) => s.url)).toEqual(["https://api.test/a"]);
  });

  it("refuses a redirect from https down to plain http", async () => {
    const { seen } = route({
      "https://api.test/a": { status: 302, location: "http://api.test/a" },
    });
    process.env[ENV] = "tok";
    await expect(getter()("/a")).rejects.toThrow(/another origin/);
    expect(seen).toHaveLength(1);
  });

  it("refuses the fourth hop", async () => {
    const { seen } = route({
      "https://api.test/a": { status: 301, location: "/b" },
      "https://api.test/b": { status: 301, location: "/c" },
      "https://api.test/c": { status: 301, location: "/d" },
      "https://api.test/d": { status: 301, location: "/e" },
      "https://api.test/e": { status: 200, body: "{}" },
    });
    process.env[ENV] = "tok";
    await expect(getter()("/a")).rejects.toThrow(/too many redirects/);
    expect(seen.map((s) => s.url)).toEqual([
      "https://api.test/a",
      "https://api.test/b",
      "https://api.test/c",
      "https://api.test/d",
    ]);
  });

  it("carries a custom credential header on a same-origin hop and never to another origin", async () => {
    const seenHeaders: { url: string; key: string | null }[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      seenHeaders.push({ url, key: new Headers(init?.headers).get("zotero-api-key") });
      if (url === "https://api.test/a") {
        return new Response(null, { status: 301, headers: { location: "/b" } });
      }
      if (url === "https://api.test/b") {
        return new Response(null, { status: 302, headers: { location: "https://evil.test/c" } });
      }
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    process.env[ENV] = "tok";
    const get = createJsonGetter({
      base: "https://api.test",
      label: "T",
      headers: envAuthHeaders({ env: ENV, scheme: "", header: "Zotero-API-Key" }),
    });
    await expect(get("/a")).rejects.toThrow(/another origin/);
    expect(seenHeaders).toEqual([
      { url: "https://api.test/a", key: "tok" },
      { url: "https://api.test/b", key: "tok" },
    ]);
  });

  it("follows a plain-http base's same-origin redirect and its same-host https upgrade", async () => {
    route({
      "http://ci.internal/x": { status: 301, location: "/y" },
      "http://ci.internal/y": { status: 301, location: "https://ci.internal/z" },
      "https://ci.internal/z": { status: 200, body: "[1]" },
    });
    process.env[ENV] = "tok";
    const get = createJsonGetter({
      base: "http://ci.internal",
      label: "T",
      headers: envAuthHeaders({ env: ENV }),
    });
    expect(await get("/x")).toEqual([1]);
  });

  it("still allows a plain-http base that does not redirect (self-hosted callers)", async () => {
    route({ "http://ci.internal/x": { status: 200, body: "[]" } });
    process.env[ENV] = "tok";
    const get = createJsonGetter({
      base: "http://ci.internal",
      label: "T",
      headers: envAuthHeaders({ env: ENV }),
    });
    expect(await get("/x")).toEqual([]);
  });
});
