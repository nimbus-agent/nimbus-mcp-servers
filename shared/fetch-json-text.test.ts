import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { fetchJsonText } from "./fetch-json-text.ts";

describe("fetchJsonText", () => {
  const realFetch = globalThis.fetch;
  let seen: { url: string; init: RequestInit | undefined }[] = [];
  let answer: () => Response;

  beforeEach(() => {
    seen = [];
    answer = () => new Response('{"ok":1}', { status: 200 });
    globalThis.fetch = ((url: string, init?: RequestInit) => {
      seen.push({ url, init });
      return Promise.resolve(answer());
    }) as unknown as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  function sentHeaders(): Record<string, string> {
    return (seen[0]?.init?.headers ?? {}) as Record<string, string>;
  }

  it("sends the base headers as given and returns the raw text", async () => {
    const out = await fetchJsonText("https://x/api", { Authorization: "Bearer t", "X-V": "1" });
    expect(out).toEqual({ ok: true, status: 200, text: '{"ok":1}' });
    expect(seen[0]?.url).toBe("https://x/api");
    expect(sentHeaders()).toEqual({ Authorization: "Bearer t", "X-V": "1" });
  });

  it("declares a JSON body only when there is one, after the base headers", async () => {
    await fetchJsonText("https://x/api", { Authorization: "Bearer t" }, { method: "GET" });
    await fetchJsonText(
      "https://x/api",
      { Authorization: "Bearer t" },
      {
        method: "POST",
        body: "{}",
      },
    );
    expect(seen[0]?.init?.headers).toEqual({ Authorization: "Bearer t" });
    expect(Object.entries(seen[1]?.init?.headers ?? {})).toEqual([
      ["Authorization", "Bearer t"],
      ["Content-Type", "application/json"],
    ]);
    expect(seen[1]?.init?.method).toBe("POST");
    expect(seen[1]?.init?.body).toBe("{}");
  });

  it("lets a caller's header override a base header and the JSON content type", async () => {
    await fetchJsonText(
      "https://x/api",
      { Accept: "application/json", Authorization: "Bearer t" },
      { method: "PUT", body: "a,b", headers: { Accept: "text/csv", "Content-Type": "text/csv" } },
    );
    expect(sentHeaders()).toEqual({
      Accept: "text/csv",
      Authorization: "Bearer t",
      "Content-Type": "text/csv",
    });
  });

  it("does not modify the base headers it was given", async () => {
    const base = { Authorization: "Bearer t" };
    await fetchJsonText("https://x/api", base, { method: "POST", body: "{}" });
    expect(base).toEqual({ Authorization: "Bearer t" });
  });

  it("reports a non-2xx with its body instead of throwing", async () => {
    answer = () => new Response("nope", { status: 403 });
    expect(await fetchJsonText("https://x/api", {})).toEqual({
      ok: false,
      status: 403,
      text: "nope",
    });
  });
});
